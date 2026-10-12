//! Runs a mod via `yog run <config> [--debug]` and, on Linux, connects to
//! the control socket `yog-runtime` opens when `YOG_CONTROL_SOCKET` is set
//! (see `Yog-Mod-Loader/rust/crates/yog-runtime/src/control_socket.rs`) —
//! this is what actually tells Yog-IDLE the real game pid and what's
//! happening inside it, replacing an earlier `/proc`-scanning discovery
//! mechanism that was fundamentally unreliable (a launcher wrapper like
//! `./gradlew` is often not even an ancestor of the real JVM once Gradle's
//! daemon is involved).
//!
//! "Debug" isn't a separately-triggered action — it's a `mode` on the
//! normal run flow (`"release"` | `"debug"`, Yog-IDLE's own vocabulary,
//! opaque to `RunBar`): a debug-mode run additionally builds with debug
//! symbols and attaches `yog-debugger` the moment the socket's `ready`
//! message gives us a trustworthy pid.
//!
//! The same socket carries hot reload the other way: `hot_reload` rebuilds
//! the project and asks the runtime to swap in the new `.yog` in place.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nix::sys::signal::Signal;
use nix::unistd::Pid;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use yog_debugger::{Debugger, SourceBreakpoints, StepKind, StopReason, is_library_source};
use yog_hot_reload::{GenerationAllocator, ModuleGeneration};
use yog_symbols::{FrameRegs, SymbolTable, TargetMemory, ValueNode, ValueRef};

/// Everything the tracer thread owns for one attached debug session — see
/// `tracer_main`. Never leaves that thread.
struct Tracer {
    debugger: Debugger,
    native_path: PathBuf,
    symbols: SymbolTable,
    module_base: u64,
    mod_id: String,
    /// One per load of the mod's native seen by this session — the initial
    /// attach, then each successful hot reload — so `SourceBreakpoints` can
    /// tell which load every breakpoint was last resolved against.
    generations: GenerationAllocator,
    generation: ModuleGeneration,
    breakpoints: SourceBreakpoints,
    /// Why the tracee last stopped — re-reported when the user switches
    /// threads, so the UI keeps showing "breakpoint" rather than a new stop.
    last_stop: StopReason,
    /// Expandable values handed out (`VariableOut::handle`) since the
    /// tracee last stopped — they name places in its memory, so they're
    /// dropped as soon as it runs again (or the native is reloaded).
    values: HashMap<u64, ValueRef>,
    next_value: u64,
}

/// A request for the tracer thread. Breakpoint edits are applied whether
/// the tracee is paused or running (a running one is briefly interrupted —
/// see `TracerHandle::send`); `Continue`/`Step` only mean anything while
/// it's paused.
enum TracerCmd {
    SetBreakpoint {
        file: String,
        line: u32,
    },
    ClearBreakpoint {
        file: String,
        line: u32,
    },
    Continue,
    Step(StepKind),
    /// Break All: stop the running game wherever it is.
    Pause,
    /// Inspect another (stopped) thread: re-emits `debug-stopped` with its
    /// stack and registers.
    SelectThread(i32),
    /// The runtime just hot-reloaded the mod: reload symbols from the
    /// freshly built native and re-resolve every breakpoint against them.
    Rebind,
    /// A read-only look at the paused tracee (locals, watch expressions,
    /// expanding a value) — see `tracer_query`.
    Inspect(Box<dyn FnOnce(&mut Tracer) + Send>),
    /// Yog-IDLE is exiting: take every breakpoint out and let the game run
    /// on untraced, then say so on `done`.
    Detach {
        done: Sender<()>,
    },
}

/// The state `TracerHandle` shares with its tracer thread.
struct TracerFlags {
    running: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    pause_request: Arc<AtomicBool>,
}

#[derive(Clone, Copy)]
enum Resume {
    Continue,
    Step(StepKind),
}

/// The rest of the app's way to reach a debug-mode run's tracer thread.
struct TracerHandle {
    tx: Sender<TracerCmd>,
    pid: i32,
    /// `true` while the tracee is executing a Continue or a step and the
    /// tracer thread is blocked in `waitpid` — the only state in which it
    /// can't pick up a command on its own.
    running: Arc<AtomicBool>,
    /// `true` while the tracer is parked waiting for the user — the only
    /// time a Continue/Step is accepted (see `TracerHandle::resume`).
    paused: Arc<AtomicBool>,
    /// Raised with a Pause sent while running, so a step in progress gives
    /// up for it (`Debugger::set_pause_request`) instead of absorbing it
    /// like a breakpoint edit's interrupt.
    pause_request: Arc<AtomicBool>,
}

impl TracerHandle {
    /// Queues `cmd`; if it's one that has to take effect *now* (a
    /// breakpoint edit) and the tracee is running, also interrupts it so
    /// the tracer's `waitpid` returns and it can drain its queue —
    /// `tracer_main` gets `StopReason::Interrupted` and resumes straight
    /// afterward. Returns `false` once the tracer thread is gone.
    fn send(&self, cmd: TracerCmd) -> bool {
        let urgent = matches!(
            cmd,
            TracerCmd::SetBreakpoint { .. }
                | TracerCmd::ClearBreakpoint { .. }
                | TracerCmd::Rebind
                | TracerCmd::Pause
                | TracerCmd::Detach { .. }
        );
        let pause = matches!(cmd, TracerCmd::Pause);
        if self.tx.send(cmd).is_err() {
            return false;
        }
        if urgent && self.running.load(Ordering::SeqCst) {
            if pause {
                self.pause_request.store(true, Ordering::SeqCst);
            }
            yog_debugger::ptrace_debugger::interrupt(self.pid);
        }
        true
    }

    /// Queues a Continue/Step — only while the tracer is paused waiting for
    /// one, and only one per pause: a held-down F10 must not pile up steps
    /// that then run back to back (or after a step that turned into a free
    /// run) long after the key was let go.
    fn resume(&self, cmd: TracerCmd) -> Result<(), String> {
        if self
            .paused
            .compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("not paused".to_string());
        }
        self.tx
            .send(cmd)
            .map_err(|_| "no active debug session".to_string())
    }
}

/// One `yog run` launch — always present while the process is up, whether
/// or not it's a debug-mode run. `tracer` is only `Some` for a debug-mode
/// run, from the moment the game reported its pid (attach itself then
/// happens on the tracer thread).
pub struct RunSession {
    /// Distinguishes this launch from whatever replaces it — a Restart
    /// starts a new session while the old one's socket reader/exit watcher
    /// threads are still winding down, and those must only ever tear down
    /// *their own* session, never the fresh one.
    id: u64,
    wrapper: Child,
    /// Keeps the run's Output tail going until the session ends.
    _output: crate::OutputTail,
    real_pid: Option<i32>,
    /// A debug-mode run — a hot reload then rebuilds with debug info kept
    /// too, so the debugger still has symbols for the reloaded native.
    debug_mode: bool,
    /// Write half of the control socket, once it's connected (the read
    /// half lives on `connect_and_watch`'s thread).
    control: Option<UnixStream>,
    /// Set while `hot_reload` waits for the runtime's `hot-reload-done`.
    hot_reload_waiter: Option<Sender<bool>>,
    tracer: Option<TracerHandle>,
}

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct DebugState(pub Mutex<Option<RunSession>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackFrameOut {
    pub id: i64,
    pub name: String,
    pub file: String,
    pub line: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugStoppedEvent {
    pub reason: String,
    pub stack_trace: Vec<StackFrameOut>,
    /// Every thread of the tracee — only some are stopped (see
    /// `ThreadOut::stopped`): the debugger runs non-stop.
    pub threads: Vec<ThreadOut>,
    /// The thread `stack_trace`/`registers` describe — the one that hit the
    /// breakpoint, or whichever the user picked with `debug_select_thread`.
    pub thread: i32,
    /// General-purpose registers of `thread`, as `(name, hex value)`.
    pub registers: Vec<(String, String)>,
}

impl DebugStoppedEvent {
    fn exited() -> Self {
        Self {
            reason: "exited".to_string(),
            stack_trace: Vec::new(),
            threads: Vec::new(),
            thread: 0,
            registers: Vec::new(),
        }
    }
}

/// One row of the Locals/Watch/Autos views and DataTips — a
/// `yog_symbols::ValueNode`. `children` is only ever filled for an eagerly
/// read tree; rows with a `handle` are expanded on demand with
/// `debug_children`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableOut {
    pub name: String,
    pub type_name: String,
    pub value: String,
    pub children: Vec<VariableOut>,
    /// An expression that evaluates back to this row ("Add Watch").
    pub expr: String,
    /// Set when the row can be expanded: pass to `debug_children` while
    /// the tracee is still paused at the same stop.
    pub handle: Option<u64>,
}

/// One watch expression's result: a row, or why there isn't one.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchOut {
    pub value: Option<VariableOut>,
    pub error: Option<String>,
}

/// The tracee's memory through `/proc/<pid>/mem` — readable by its tracer
/// while it's stopped, and far cheaper than a word-at-a-time `PTRACE_PEEKDATA`.
struct ProcMem(std::fs::File);

impl ProcMem {
    fn open(pid: Pid) -> Result<Self, String> {
        std::fs::File::open(format!("/proc/{pid}/mem"))
            .map(Self)
            .map_err(|e| format!("opening /proc/{pid}/mem: {e}"))
    }
}

impl TargetMemory for ProcMem {
    fn read(&self, addr: u64, buf: &mut [u8]) -> bool {
        use std::os::unix::fs::FileExt;
        self.0.read_exact_at(buf, addr).is_ok()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadOut {
    pub id: i32,
    /// `/proc/<pid>/task/<tid>/comm` — the JVM names its threads
    /// ("Server thread", "Render thread", ...).
    pub name: String,
    /// Stopped (inspectable), as opposed to still running: a breakpoint
    /// stops only the thread that hit it, Break All only `is_game_thread`s.
    pub stopped: bool,
}

/// The threads Break All stops: the ones mod code runs on — the client's
/// render thread and the integrated server's tick thread. Everything else
/// (sound, networking, GC, ...) keeps going, so pausing the game doesn't
/// stall the system's audio or drop the connection.
fn is_game_thread(name: &str) -> bool {
    matches!(name, "Render thread" | "Server thread")
}

fn to_snake_name(id: &str) -> String {
    // Mirrors yog-cli's own `to_snake_name` exactly — the native's lib name
    // (and therefore its filename) is derived this way, and Yog-IDLE has to
    // agree with yog-cli's convention to find the same file on disk.
    let mut out = String::with_capacity(id.len());
    for c in id.chars() {
        if c == '-' || c == '_' {
            if !out.ends_with('_') {
                out.push('_');
            }
        } else if c.is_uppercase() {
            if !out.is_empty() && !out.ends_with('_') {
                out.push('_');
            }
            out.extend(c.to_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// Reads `[mod]`/`[package]`'s `id` out of a `yog.toml` — the minimal slice
/// of yog-cli's own parsing this needs, not a general yog.toml reader.
fn read_mod_id(contents: &str) -> Option<String> {
    let mut section = "";
    for raw in contents.lines() {
        let line = raw.trim();
        if line.starts_with('[') && line.ends_with(']') {
            section = &line[1..line.len() - 1];
            continue;
        }
        if section != "mod" && section != "package" {
            continue;
        }
        if let Some(value) = line
            .strip_prefix("id")
            .and_then(|rest| rest.trim_start().strip_prefix('='))
        {
            return Some(value.trim().trim_matches('"').to_string());
        }
    }
    None
}

/// The local, just-built unstripped native's path — `target/<triple>/
/// release/<lib>`, exactly how `yog-cli`'s `Builder`/`package()` name it for
/// the host platform. Not the runtime-extracted temp copy (unpredictable —
/// see `find_latest_module_base`) — this is only used for
/// its DWARF data, which is byte-identical between the two.
///
/// `release` is correct for debug-mode runs too: `yog run --debug` (like
/// `yog build debug`) is still a `cargo build --release`, just with
/// `CARGO_PROFILE_RELEASE_DEBUG=true`/`..._STRIP=none` so the debug info
/// survives — there is no separate `debug/` output for it.
fn local_native_path(project_root: &Path, mod_id: &str) -> PathBuf {
    let triple = match std::env::consts::ARCH {
        "aarch64" => "aarch64-unknown-linux-gnu",
        _ => "x86_64-unknown-linux-gnu",
    };
    let lib = format!("lib{}.so", to_snake_name(mod_id));
    project_root
        .join("target")
        .join(triple)
        .join("release")
        .join(lib)
}

/// Load base of `mod_id`'s native in `pid`. The runtime extracts each load
/// to a fresh `yog-<mod_id>-<pid>-<n>.<ext>` in the temp dir, so after a hot
/// reload several copies can be mapped at once — pick the newest (highest
/// `n`). Matching the whole name, not a prefix, keeps `yog-pipes` from
/// matching a `yog-pipes-extra` mod.
fn find_latest_module_base(pid: Pid, mod_id: &str) -> Option<u64> {
    let maps = std::fs::read_to_string(format!("/proc/{}/maps", pid.as_raw())).ok()?;
    let prefix = format!("yog-{mod_id}-");
    let mut best: Option<(u64, u64)> = None; // (n, base)
    for line in maps.lines() {
        let mut fields = line.split_whitespace();
        let range = fields.next()?;
        let Some(path) = fields.nth(4) else { continue };
        let Some(name) = Path::new(path).file_name().and_then(|f| f.to_str()) else {
            continue;
        };
        let Some(rest) = name.strip_prefix(&prefix) else {
            continue;
        };
        let stem = rest.split('.').next().unwrap_or("");
        // `<pid>-<n>`; older runtimes wrote just `<pid>` (n = 0).
        let mut parts = stem.split('-');
        let pid_ok = parts.next().is_some_and(|p| p.parse::<u32>().is_ok());
        let n = match parts.next() {
            Some(n) => match n.parse::<u64>() {
                Ok(n) => n,
                Err(_) => continue,
            },
            None => 0,
        };
        if !pid_ok || parts.next().is_some() {
            continue;
        }
        let Some(base) = range
            .split('-')
            .next()
            .and_then(|h| u64::from_str_radix(h, 16).ok())
        else {
            continue;
        };
        // The first mapping of a file is its lowest address — the load base.
        match best {
            Some((bn, _)) if bn >= n => {}
            _ => best = Some((n, base)),
        }
    }
    best.map(|(_, base)| base)
}

fn control_socket_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "yog-idle-{}-{}.sock",
        std::process::id(),
        std::time::SystemTime::now().elapsed_or_zero_nanos()
    ))
}

// `SystemTime` has no direct "nanos since some fixed point" accessor without
// a fallible `duration_since` — this just makes the call site above read
// cleanly instead of unwrapping inline.
trait ElapsedOrZero {
    fn elapsed_or_zero_nanos(&self) -> u128;
}
impl ElapsedOrZero for std::time::SystemTime {
    fn elapsed_or_zero_nanos(&self) -> u128 {
        self.duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    }
}

/// Runs `name` (`yog run <name> [--debug]`), always connecting the control
/// socket for live `game-status` events; if `mode == "debug"`, also
/// attaches `yog-debugger` the moment the socket's `ready` message arrives.
///
/// Returns as soon as the child is spawned — everything after that runs on
/// a background thread and reports back via `game-status`/`debug-attached`/
/// `debug-attach-failed` events. A command that instead blocked here on a
/// socket read that never arrives would hang Tauri's invoke call (and,
/// since its blocking-thread pool is bounded, eventually every *other*
/// command too) for as long as that read blocks.
pub fn run_with_mode(
    app: AppHandle,
    project_root: String,
    config_name: String,
    mode: String,
) -> Result<(), String> {
    let root = PathBuf::from(&project_root);
    let yog_toml = std::fs::read_to_string(root.join("yog.toml")).map_err(|e| e.to_string())?;
    let mod_id = read_mod_id(&yog_toml).ok_or("yog.toml has no [mod]/[package] id")?;
    let debug = mode == "debug";
    let native_path = local_native_path(&root, &mod_id);
    let socket_path = control_socket_path();

    let mut args = vec!["run".to_string(), config_name.clone()];
    if debug {
        args.push("--debug".to_string());
    }

    let (child, log) = crate::spawn_yog_run(
        Command::new("yog")
            .args(&args)
            .current_dir(&root)
            .env("YOG_CONTROL_SOCKET", &socket_path),
    )
    .map_err(|e| format!("failed to launch `yog run {config_name}`: {e}"))?;
    let output = crate::stream_yog_run(&app, log);

    let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    *app.state::<DebugState>().0.lock().unwrap() = Some(RunSession {
        id,
        wrapper: child,
        _output: output,
        real_pid: None,
        debug_mode: debug,
        control: None,
        hot_reload_waiter: None,
        tracer: None,
    });
    let _ = app.emit(
        "game-status",
        GameStatus {
            stage: "starting",
            pid: None,
            mods: Vec::new(),
        },
    );

    spawn_exit_watcher(app.clone(), id);
    std::thread::spawn(move || connect_and_watch(app, id, socket_path, mod_id, debug, native_path));
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModInfoOut {
    id: String,
    name: String,
    version: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameStatus {
    stage: &'static str,
    pid: Option<i32>,
    mods: Vec<ModInfoOut>,
}

/// Retries connecting to the control socket (the child needs a moment to
/// reach `nativeInit`), reads the `ready` line for the real pid directly —
/// no `/proc` walking at all — then keeps reading further event lines for
/// the rest of the session, translating each into a `game-status` event.
fn connect_and_watch(
    app: AppHandle,
    session_id: u64,
    socket_path: PathBuf,
    mod_id: String,
    debug: bool,
    native_path: PathBuf,
) {
    let connect_deadline = Instant::now() + Duration::from_secs(90);
    let stream = loop {
        match UnixStream::connect(&socket_path) {
            Ok(s) => break Some(s),
            Err(_) if Instant::now() < connect_deadline => {
                std::thread::sleep(Duration::from_millis(200))
            }
            Err(_) => break None,
        }
    };

    let Some(stream) = stream else {
        // Not fatal for a plain run — an older yog-runtime without socket
        // support, or a mod that never got as far as `nativeInit`, just
        // means no live status/attach for this session, not that the game
        // itself failed to launch.
        let _ = app.emit(
            crate::OUTPUT_DEBUG,
            "[warn] control socket never connected — no live status or debugger attach available for this run".to_string(),
        );
        if debug {
            emit_failed(
                &app,
                "control socket never connected — is this mod's yog-runtime new enough to support it?",
            );
        }
        return;
    };

    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });

    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let Ok(ready) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return;
    };
    let Some(real_pid) = ready.get("pid").and_then(|v| v.as_i64()).map(|v| v as i32) else {
        return;
    };
    let mods = parse_mods(&ready);
    // Whether the runtime handed us `PR_SET_PTRACER` — absent from runtimes
    // that predate it, which is what an `EPERM` attach then means.
    let ptracer = ready.get("ptracer").and_then(|v| v.as_bool());

    {
        let debug_state = app.state::<DebugState>();
        let mut guard = debug_state.0.lock().unwrap();
        match guard.as_mut() {
            Some(session) if session.id == session_id => {
                session.real_pid = Some(real_pid);
                session.control = stream.try_clone().ok();
            }
            // Stopped (or restarted) before the game even reported in.
            _ => return,
        }
    }
    let _ = app.emit(
        "game-status",
        GameStatus {
            stage: "ready",
            pid: Some(real_pid),
            mods,
        },
    );

    if debug {
        start_tracer(&app, session_id, real_pid, mod_id, native_path, ptracer);
    }

    // Keep reading further event lines for the rest of the session: a
    // refreshed mod list (`mods`) becomes another `game-status` "ready",
    // same shape as the `ready` handling above; `hot-reload-done` answers
    // whichever `hot_reload` call is waiting on it; anything else is just
    // echoed to Output. When the game process exits (however it
    // exits — the user closing the client themselves, a crash, Stop) the
    // OS closes its end of the socket, so this read loop ending is exactly
    // the "the game is gone" signal: emit it and clean up the session
    // instead of silently leaving stale state around (a manually-closed
    // client previously left Yog-IDLE with no idea anything had changed).
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if let Ok(event) = serde_json::from_str::<serde_json::Value>(line.trim()) {
                    handle_control_event(&app, session_id, real_pid, &event, line.trim());
                }
            }
        }
    }
    mark_exited(&app, session_id);
}

fn parse_mods(message: &serde_json::Value) -> Vec<ModInfoOut> {
    let field = |m: &serde_json::Value, key: &str| {
        m.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    };
    message
        .get("mods")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|m| ModInfoOut {
                    id: field(m, "id"),
                    name: field(m, "name"),
                    version: field(m, "version"),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn handle_control_event(
    app: &AppHandle,
    session_id: u64,
    real_pid: i32,
    event: &serde_json::Value,
    raw: &str,
) {
    match event.get("event").and_then(|v| v.as_str()) {
        Some("mods") => {
            let _ = app.emit(
                "game-status",
                GameStatus {
                    stage: "ready",
                    pid: Some(real_pid),
                    mods: parse_mods(event),
                },
            );
        }
        Some("hot-reload-done") => {
            let ok = event.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            let debug_state = app.state::<DebugState>();
            let mut guard = debug_state.0.lock().unwrap();
            let waiter = guard
                .as_mut()
                .filter(|s| s.id == session_id)
                .and_then(|s| s.hot_reload_waiter.take());
            match waiter {
                Some(waiter) => {
                    let _ = waiter.send(ok);
                }
                // Nobody asked (or it already timed out) — still worth showing.
                None => {
                    let _ = app.emit(crate::OUTPUT_DEBUG, format!("[control] {raw}"));
                }
            }
        }
        other => {
            let _ = app.emit(
                crate::OUTPUT_DEBUG,
                format!("[control] {}: {raw}", other.unwrap_or("unknown")),
            );
        }
    }
}

/// Only one hot reload at a time — a second click while the first is still
/// building would otherwise race it for `artifacts/<id>.yog`.
static HOT_RELOAD_BUSY: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HotReloadEvent {
    /// `"building"` | `"reloading"` | `"done"`.
    stage: &'static str,
    mod_id: String,
    /// Only set once `stage == "done"`.
    ok: Option<bool>,
    message: String,
}

fn emit_hot_reload(
    app: &AppHandle,
    stage: &'static str,
    mod_id: &str,
    ok: Option<bool>,
    message: String,
) {
    let prefix = match ok {
        Some(false) => "[error] ",
        _ => "",
    };
    let _ = app.emit(
        crate::OUTPUT_BUILD,
        format!("{prefix}hot reload: {message}"),
    );
    let _ = app.emit(
        "hot-reload",
        HotReloadEvent {
            stage,
            mod_id: mod_id.to_string(),
            ok,
            message,
        },
    );
}

/// Rebuilds the open project (`yog build`, or `yog build debug` for a
/// debug-mode run) and asks the running game to hot-reload it over the
/// control socket: `{"cmd":"hot_reload","mod_id",..,"yog_path":..}`,
/// answered by `{"event":"hot-reload-done","ok":..}`. The runtime only
/// accepts a `.yog` built against the exact same ABI version it's running.
///
/// Returns once the work is started — progress and the outcome arrive as
/// `hot-reload` events (plus Output lines), same reasoning as
/// `run_with_mode`'s about not blocking an invoke on a long-running wait.
pub fn hot_reload(app: AppHandle, project_root: String) -> Result<(), String> {
    let root = PathBuf::from(&project_root);
    let yog_toml = std::fs::read_to_string(root.join("yog.toml")).map_err(|e| e.to_string())?;
    let mod_id = read_mod_id(&yog_toml).ok_or("yog.toml has no [mod]/[package] id")?;

    let (session_id, debug_mode) = {
        let debug_state = app.state::<DebugState>();
        let guard = debug_state.0.lock().unwrap();
        let session = guard.as_ref().ok_or("the game isn't running")?;
        if session.control.is_none() {
            return Err(
                "the game hasn't connected its control socket (yet) — hot reload needs it"
                    .to_string(),
            );
        }
        (session.id, session.debug_mode)
    };
    if HOT_RELOAD_BUSY.swap(true, Ordering::SeqCst) {
        return Err("a hot reload is already in progress".to_string());
    }

    std::thread::spawn(move || {
        let (ok, message) = match run_hot_reload(&app, &root, &mod_id, session_id, debug_mode) {
            Ok(()) => (true, format!("{mod_id} reloaded")),
            Err(e) => (false, e),
        };
        HOT_RELOAD_BUSY.store(false, Ordering::SeqCst);
        emit_hot_reload(&app, "done", &mod_id, Some(ok), message);
    });
    Ok(())
}

fn run_hot_reload(
    app: &AppHandle,
    root: &Path,
    mod_id: &str,
    session_id: u64,
    debug_mode: bool,
) -> Result<(), String> {
    let mut args = vec!["build"];
    if debug_mode {
        args.push("debug");
    }
    emit_hot_reload(
        app,
        "building",
        mod_id,
        None,
        format!("running `yog {}`", args.join(" ")),
    );
    let mut child = Command::new("yog")
        .args(&args)
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch `yog build`: {e}"))?;
    // `yog build` reports progress on stderr — not a warning in itself.
    let pipes: Vec<Box<dyn std::io::Read + Send>> = [
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    .collect();
    let readers: Vec<_> = pipes
        .into_iter()
        .map(|pipe| {
            let out_app = app.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    let _ = out_app.emit(crate::OUTPUT_BUILD, line);
                }
            })
        })
        .collect();
    let status = child.wait().map_err(|e| e.to_string())?;
    for reader in readers {
        let _ = reader.join();
    }
    if !status.success() {
        return Err(format!(
            "`yog build` failed ({status}) — the game keeps running the previous build"
        ));
    }

    let yog_path = root.join("artifacts").join(format!("{mod_id}.yog"));
    let yog_path = yog_path
        .canonicalize()
        .map_err(|e| format!("{}: {e}", yog_path.display()))?;

    let (tx, rx) = mpsc::channel();
    {
        let debug_state = app.state::<DebugState>();
        let mut guard = debug_state.0.lock().unwrap();
        let session = guard
            .as_mut()
            .filter(|s| s.id == session_id)
            .ok_or("the game exited during the build")?;
        let control = session.control.as_mut().ok_or("control socket is gone")?;
        let request = serde_json::json!({
            "cmd": "hot_reload",
            "mod_id": mod_id,
            "yog_path": yog_path.to_string_lossy(),
        });
        writeln!(control, "{request}")
            .map_err(|e| format!("writing to the control socket: {e}"))?;
        session.hot_reload_waiter = Some(tx);
    }
    emit_hot_reload(
        app,
        "reloading",
        mod_id,
        None,
        format!("sent {} to the game", yog_path.display()),
    );

    let ok = match rx.recv_timeout(Duration::from_secs(60)) {
        Ok(ok) => ok,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            return Err("the game didn't answer within 60s".to_string());
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err("the game exited before answering".to_string());
        }
    };
    if !ok {
        return Err(format!(
            "the game rejected the new build of {mod_id} (see the game log — most often an ABI version mismatch, \
             which needs a full restart)"
        ));
    }

    let debug_state = app.state::<DebugState>();
    let mut guard = debug_state.0.lock().unwrap();
    if let Some(session) = guard.as_mut().filter(|s| s.id == session_id) {
        if let Some(tracer) = &session.tracer {
            tracer.send(TracerCmd::Rebind);
        }
        // A reload can change the mod's reported version — refresh the list
        // (the answer arrives as a `mods` event, see `handle_control_event`).
        if let Some(control) = session.control.as_mut() {
            let _ = writeln!(control, "{}", serde_json::json!({ "cmd": "list_mods" }));
        }
    }
    Ok(())
}

/// Clears whatever's left of the session and reports "the game is gone" —
/// called both when the control socket drops (the common, prompt path) and
/// by `spawn_exit_watcher`'s `try_wait` polling (the backstop for a run
/// whose socket never connected in the first place, e.g. an older
/// `yog-runtime` without control-socket support). Safe to call more than
/// once — a session that's already gone (or already replaced by a newer
/// one, e.g. after Restart) is simply a no-op.
fn mark_exited(app: &AppHandle, session_id: u64) {
    let had_session = {
        let debug_state = app.state::<DebugState>();
        let mut guard = debug_state.0.lock().unwrap();
        if guard.as_ref().is_some_and(|s| s.id == session_id) {
            *guard = None;
            true
        } else {
            false
        }
    };
    if had_session {
        let _ = app.emit(
            "game-status",
            GameStatus {
                stage: "exited",
                pid: None,
                mods: Vec::new(),
            },
        );
        let _ = app.emit("debug-stopped", DebugStoppedEvent::exited());
        // `useModRunTargets`'s `running` flag only ever resets on this
        // event (a holdover from the old `run_and_stream`-based flow,
        // which fired it automatically) — without it, `RunBar`'s Start
        // button stays disabled forever after the game exits, since
        // nothing in this newer control-socket flow ever emitted it.
        let _ = app.emit("workflow-exit", ());
    }
}

/// Backstop for detecting the game exiting when the control socket never
/// connected at all (so `connect_and_watch`'s own read loop never got a
/// chance to notice the drop): polls the spawned wrapper process
/// non-blockingly every second and reports "exited" the moment it's gone —
/// whether that's the user closing the client themselves, a crash, or
/// `debug_stop`. Exits its own loop once the session is gone by any means
/// (this watcher's own detection, or `connect_and_watch`'s).
fn spawn_exit_watcher(app: AppHandle, session_id: u64) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let debug_state = app.state::<DebugState>();
            let mut guard = debug_state.0.lock().unwrap();
            let Some(session) = guard.as_mut().filter(|s| s.id == session_id) else {
                return;
            };
            match session.wrapper.try_wait() {
                Ok(Some(_)) => {
                    drop(guard);
                    mark_exited(&app, session_id);
                    return;
                }
                Ok(None) => continue,
                Err(_) => return,
            }
        }
    });
}

/// Reports a debug-lifecycle failure both as the dedicated event
/// (`useDebugSession`/`DebugPanel` react to it) *and* as a `workflow-output`
/// line, so it's visible in the Output panel too — that's far more likely
/// to already be open than the Debug panel is at the point an attach fails.
fn emit_failed(app: &AppHandle, message: impl Into<String>) {
    let message = message.into();
    let _ = app.emit("debug-attach-failed", message.clone());
    let _ = app.emit(crate::OUTPUT_DEBUG, format!("[error] {message}"));
}

/// An attached session's tracer gave up mid-session — reported as
/// `debug-failed` (not `debug-attach-failed`: the attach itself worked),
/// unless the session it belonged to is already over (Stop, the game
/// exiting, a newer run), where a late `ptrace` error from the dying
/// process is just noise — or the game itself is what went away, which
/// is an exit, not a failure.
fn emit_session_failed(app: &AppHandle, session_id: u64, real_pid: i32, message: String) {
    let current = app
        .state::<DebugState>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|s| s.id == session_id);
    if !current {
        return;
    }
    if process_gone(real_pid) {
        let _ = app.emit("debug-stopped", DebugStoppedEvent::exited());
        return;
    }
    let _ = app.emit("debug-failed", message.clone());
    let _ = app.emit(crate::OUTPUT_DEBUG, format!("[error] debugger: {message}"));
}

/// Whether `pid` has exited (or is only a zombie left to be reaped).
fn process_gone(pid: i32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).map_or(true, |stat| {
        stat.rsplit_once(')')
            .and_then(|(_, rest)| rest.trim_start().chars().next())
            .is_none_or(|state| matches!(state, 'Z' | 'X'))
    })
}

/// Registers a `TracerHandle` on the session (so breakpoint toggles made
/// while attach is still in progress queue up instead of being lost) and
/// spawns the tracer thread itself.
fn start_tracer(
    app: &AppHandle,
    session_id: u64,
    real_pid: i32,
    mod_id: String,
    native_path: PathBuf,
    ptracer: Option<bool>,
) {
    let (tx, rx) = mpsc::channel();
    let running = Arc::new(AtomicBool::new(false));
    let paused = Arc::new(AtomicBool::new(false));
    let pause_request = Arc::new(AtomicBool::new(false));
    {
        let debug_state = app.state::<DebugState>();
        let mut guard = debug_state.0.lock().unwrap();
        match guard.as_mut() {
            Some(session) if session.id == session_id => {
                session.tracer = Some(TracerHandle {
                    tx,
                    pid: real_pid,
                    running: running.clone(),
                    paused: paused.clone(),
                    pause_request: pause_request.clone(),
                });
            }
            _ => return,
        }
    }
    let app = app.clone();
    let flags = TracerFlags {
        running,
        paused,
        pause_request,
    };
    std::thread::spawn(move || {
        tracer_main(
            app,
            session_id,
            real_pid,
            mod_id,
            native_path,
            ptracer,
            rx,
            flags,
        )
    });
}

/// The one thread that ever touches the tracee. Linux `ptrace` binds a
/// tracee to the *thread* that attached, not the process — every later
/// `PTRACE_*` request from any other thread fails with `ESRCH` — so attach,
/// breakpoint edits, continue/step, and backtraces all have to run here,
/// fed by `TracerCmd`s, rather than on whichever Tauri command thread
/// happened to ask.
///
/// `Debugger::attach` leaves the tracee stopped (attach + `waitpid`), so
/// right after arming breakpoints this resumes it — otherwise the game
/// would sit frozen with nothing in the UI able to continue it.
#[allow(clippy::too_many_arguments)]
fn tracer_main(
    app: AppHandle,
    session_id: u64,
    real_pid: i32,
    mod_id: String,
    native_path: PathBuf,
    ptracer: Option<bool>,
    rx: Receiver<TracerCmd>,
    flags: TracerFlags,
) {
    let TracerFlags {
        running,
        paused,
        pause_request,
    } = flags;
    let mut tracer = match Tracer::attach(&app, real_pid, &mod_id, &native_path, ptracer) {
        Ok(t) => t,
        Err(e) => {
            emit_failed(&app, e);
            return;
        }
    };
    tracer.debugger.set_pause_request(pause_request.clone());
    // Anything toggled while attach was in progress — already reflected in
    // `BREAKPOINTS` (and therefore armed above) or not, applying it again
    // is idempotent.
    while let Ok(cmd) = rx.try_recv() {
        tracer.apply(&app, cmd);
    }
    let _ = app.emit("debug-attached", real_pid);

    let mut resume = Some(Resume::Continue);
    loop {
        if let Some(kind) = resume.take() {
            tracer.values.clear();
            let result = match kind {
                Resume::Continue => {
                    running.store(true, Ordering::SeqCst);
                    let result = tracer.debugger.continue_();
                    running.store(false, Ordering::SeqCst);
                    result
                }
                // A step can turn into a free run (stepping off the end of
                // the mod's code continues to the next breakpoint), so it
                // must be interruptible for Pause/breakpoint edits too.
                Resume::Step(step) => {
                    running.store(true, Ordering::SeqCst);
                    let result =
                        tracer
                            .debugger
                            .source_step(step, &tracer.symbols, tracer.module_base);
                    running.store(false, Ordering::SeqCst);
                    result
                }
            };
            match result {
                // Our own interrupt (see `TracerHandle::send`): apply what
                // was queued and carry on with whatever was in progress.
                Ok(StopReason::Interrupted) => {
                    let mut pause = pause_request.swap(false, Ordering::SeqCst);
                    while let Ok(cmd) = rx.try_recv() {
                        match cmd {
                            TracerCmd::Pause => pause = true,
                            cmd => tracer.apply(&app, cmd),
                        }
                    }
                    // Detached (Yog-IDLE exiting): nothing left to run.
                    if tracer.debugger.threads().is_empty() {
                        return;
                    }
                    if !pause {
                        // A step only lets an edit's interrupt through once
                        // it has turned into a free run (stepping off the
                        // end of the mod's code back into Java), and what's
                        // left of it is that run — its thread may be long
                        // gone, so it can't be stepped again.
                        resume = Some(Resume::Continue);
                        continue;
                    }
                    if let Err(e) = tracer.debugger.pause() {
                        emit_session_failed(&app, session_id, real_pid, e.to_string());
                        break;
                    }
                    tracer.select_interesting_thread();
                    tracer.last_stop = StopReason::Interrupted;
                    tracer.emit_stop(&app, StopReason::Interrupted);
                }
                Ok(reason) => {
                    let exited = matches!(reason, StopReason::Exited(_) | StopReason::Killed(_));
                    tracer.last_stop = reason.clone();
                    tracer.emit_stop(&app, reason);
                    if exited {
                        return;
                    }
                }
                Err(e) => {
                    emit_session_failed(&app, session_id, real_pid, e.to_string());
                    break;
                }
            }
        }
        // Paused — wait for the user. The channel closing means the
        // session itself is gone (Stop, or the game exiting). A Pause that
        // raced the stop is moot now.
        pause_request.store(false, Ordering::SeqCst);
        paused.store(true, Ordering::SeqCst);
        match rx.recv() {
            Ok(TracerCmd::Continue) => resume = Some(Resume::Continue),
            Ok(TracerCmd::Step(step)) => resume = Some(Resume::Step(step)),
            Ok(cmd) => tracer.apply(&app, cmd),
            Err(_) => break,
        }
    }
    let _ = tracer.debugger.detach();
}

impl Tracer {
    fn attach(
        app: &AppHandle,
        real_pid: i32,
        mod_id: &str,
        native_path: &Path,
        ptracer: Option<bool>,
    ) -> Result<Self, String> {
        let symbols = SymbolTable::load(native_path)
            .map_err(|e| format!("loading symbols from {}: {e}", native_path.display()))?;
        let mut debugger = Debugger::attach(real_pid).map_err(|e| {
            let raw = e.to_string();
            if raw.contains("EPERM") {
                permission_denied_message(real_pid, ptracer)
            } else {
                format!("attaching to pid {real_pid}: {raw}")
            }
        })?;
        debugger.set_pause_filter(is_game_thread);
        let Some(module_base) = find_latest_module_base(debugger.pid(), mod_id) else {
            // Attached but unusable — let the game go rather than leaving
            // it stopped.
            let _ = debugger.detach();
            return Err(format!(
                "couldn't locate {mod_id}'s native in pid {real_pid}'s memory map"
            ));
        };

        let generations = GenerationAllocator::new();
        let mut tracer = Tracer {
            debugger,
            native_path: native_path.to_path_buf(),
            symbols,
            module_base,
            mod_id: mod_id.to_string(),
            generation: generations.next(),
            generations,
            breakpoints: SourceBreakpoints::new(),
            last_stop: StopReason::Signal(Signal::SIGSTOP),
            values: HashMap::new(),
            next_value: 1,
        };
        for (file, line) in BREAKPOINTS.lock().unwrap().clone() {
            tracer.set_breakpoint(app, file, line);
        }
        Ok(tracer)
    }

    fn apply(&mut self, app: &AppHandle, cmd: TracerCmd) {
        match cmd {
            TracerCmd::SetBreakpoint { file, line } => self.set_breakpoint(app, file, line),
            TracerCmd::ClearBreakpoint { file, line } => {
                if let Err(e) =
                    self.breakpoints
                        .clear(&mut self.debugger, &self.mod_id, &file, line)
                {
                    warn(app, format!("clearing breakpoint {file}:{line}: {e}"));
                }
            }
            TracerCmd::Rebind => {
                if let Err(e) = self.rebind() {
                    warn(app, format!("re-binding breakpoints after hot reload: {e}"));
                }
            }
            // Only meaningful while paused, where `tracer_main` handles
            // them itself — one arriving mid-run is a stale double-click.
            TracerCmd::SelectThread(tid) => match self.debugger.select_thread(Pid::from_raw(tid)) {
                Ok(()) => self.emit_stop(app, self.last_stop.clone()),
                Err(e) => warn(app, format!("selecting thread {tid}: {e}")),
            },
            TracerCmd::Inspect(query) => query(self),
            TracerCmd::Detach { done } => {
                let _ = self.debugger.detach();
                let _ = done.send(());
            }
            // Already paused (a Pause racing a breakpoint hit) — nothing to do.
            TracerCmd::Pause => {}
            TracerCmd::Continue | TracerCmd::Step(_) => {}
        }
    }

    fn rebind(&mut self) -> Result<(), String> {
        let symbols = SymbolTable::load(&self.native_path)
            .map_err(|e| format!("loading symbols from {}: {e}", self.native_path.display()))?;
        let module_base = find_latest_module_base(self.debugger.pid(), &self.mod_id)
            .ok_or_else(|| format!("couldn't locate {}'s reloaded native", self.mod_id))?;
        let generation = self.generations.next();
        self.breakpoints
            .rebind_after_reload(
                &mut self.debugger,
                &self.mod_id,
                generation,
                module_base,
                &symbols,
            )
            .map_err(|e| e.to_string())?;
        self.symbols = symbols;
        self.values.clear();
        self.module_base = module_base;
        self.generation = generation;
        Ok(())
    }

    /// Arms `file:line` unless it's already tracked (`SourceBreakpoints`
    /// itself would happily track a duplicate), reporting both outright
    /// failures and lines that don't map to any code in the native.
    fn set_breakpoint(&mut self, app: &AppHandle, file: String, line: u32) {
        if self
            .breakpoints
            .all()
            .iter()
            .any(|bp| bp.file == file && bp.line == line)
        {
            return;
        }
        match self.breakpoints.set(
            &mut self.debugger,
            &self.mod_id,
            self.generation,
            self.module_base,
            &self.symbols,
            &file,
            line,
        ) {
            Err(e) => warn(app, format!("setting breakpoint {file}:{line}: {e}")),
            Ok(()) => {
                if self
                    .breakpoints
                    .all()
                    .last()
                    .is_some_and(|bp| bp.addr.is_none())
                {
                    warn(
                        app,
                        format!(
                            "breakpoint {file}:{line} doesn't map to any code in {}'s native — it won't be hit",
                            self.mod_id
                        ),
                    );
                }
            }
        }
    }

    /// After a pause, show a thread that's actually in the mod's own code
    /// if there is one; otherwise the main thread.
    fn select_interesting_thread(&mut self) {
        for tid in self.debugger.threads() {
            if self.debugger.select_thread(tid).is_ok()
                && self
                    .stack_trace()
                    .iter()
                    .any(|f| !is_library_source(Path::new(&f.file)))
            {
                return;
            }
        }
        let _ = self.debugger.select_thread(self.debugger.pid());
    }

    /// The selected thread's physical frames, unwound by CFI — through
    /// `std`, which keeps no frame pointers.
    fn frames(&self) -> Vec<FrameRegs> {
        self.debugger
            .backtrace_with(&self.symbols, self.module_base, 64)
            .unwrap_or_default()
    }

    /// Every frame in the mod's native — user code and the `std` statically
    /// linked into it — innermost first, with inlined calls as frames of
    /// their own. `id` encodes the physical frame (see `FRAME_ID_STRIDE`);
    /// `std`'s `/rustc/<commit>/...` paths point into the local `rust-src`.
    fn stack_trace(&self) -> Vec<StackFrameOut> {
        let mut out = Vec::new();
        for (i, regs) in self.frames().iter().enumerate() {
            let Some(offset) = regs.pc().checked_sub(self.module_base) else {
                continue;
            };
            for (j, location) in self.symbols.resolve_inlined(offset).into_iter().enumerate() {
                if location.line == 0 || j >= FRAME_ID_STRIDE {
                    continue;
                }
                out.push(StackFrameOut {
                    id: (i * FRAME_ID_STRIDE + j) as i64,
                    name: location.function.unwrap_or_else(|| "<unknown>".to_string()),
                    file: map_rust_src(&location.file.to_string_lossy()),
                    line: location.line,
                });
            }
        }
        out
    }

    /// The registers of the selected thread's frame `frame` (a
    /// `stack_trace` id) and the index of the function instance at its pc
    /// the id names — an inlined call's caller shows its own variables,
    /// not the callee's. The innermost frame has every register; outer
    /// ones have what CFI recovered (`rsp`, `rip` and the callee-saved
    /// registers), so variables kept in other registers read as
    /// `<unavailable>`.
    fn frame_regs(&self, frame: usize) -> Result<(FrameRegs, usize), String> {
        let frames = self.frames();
        let regs = frames
            .get(frame / FRAME_ID_STRIDE)
            .ok_or_else(|| format!("frame {frame} is past the end of the stack"))?;
        Ok((regs.clone(), frame % FRAME_ID_STRIDE))
    }

    /// A row for the UI, remembering its expandable value under a handle.
    fn row(&mut self, node: ValueNode) -> VariableOut {
        let handle = node.children.map(|value| {
            let id = self.next_value;
            self.next_value += 1;
            self.values.insert(id, value);
            id
        });
        VariableOut {
            name: node.name,
            type_name: node.type_name,
            value: node.value,
            children: Vec::new(),
            expr: node.expr,
            handle,
        }
    }

    /// Locals of the selected thread's frame `frame`, one level at a time.
    fn variables(&mut self, frame: usize) -> Result<Vec<VariableOut>, String> {
        let mem = ProcMem::open(self.debugger.pid())?;
        let (regs, inline) = self.frame_regs(frame)?;
        let nodes = self
            .symbols
            .local_nodes(&regs, self.module_base, &mem, inline);
        Ok(nodes.into_iter().map(|n| self.row(n)).collect())
    }

    /// Watch expressions evaluated in frame `frame`.
    fn evaluate(&mut self, frame: usize, exprs: &[String]) -> Result<Vec<WatchOut>, String> {
        let mem = ProcMem::open(self.debugger.pid())?;
        let (regs, inline) = self.frame_regs(frame)?;
        Ok(exprs
            .iter()
            .map(|expr| {
                match self
                    .symbols
                    .evaluate(expr, &regs, self.module_base, &mem, inline)
                {
                    Ok(node) => WatchOut {
                        value: Some(self.row(node)),
                        error: None,
                    },
                    Err(e) => WatchOut {
                        value: None,
                        error: Some(e.to_string()),
                    },
                }
            })
            .collect())
    }

    /// The rows under an expandable row from this same stop.
    fn children(&mut self, handle: u64) -> Result<Vec<VariableOut>, String> {
        let value = self
            .values
            .get(&handle)
            .cloned()
            .ok_or("the value is no longer available — the game has run since")?;
        let mem = ProcMem::open(self.debugger.pid())?;
        let nodes = self.symbols.expand(&value, &mem);
        Ok(nodes.into_iter().map(|n| self.row(n)).collect())
    }

    fn emit_stop(&self, app: &AppHandle, reason: StopReason) {
        let reason_str = match reason {
            StopReason::Breakpoint(_) => "breakpoint",
            StopReason::Signal(Signal::SIGTRAP) => "step",
            StopReason::Interrupted => "pause",
            StopReason::Signal(_) => "signal",
            StopReason::Exited(_) | StopReason::Killed(_) => "exited",
        };
        let exited = reason_str == "exited";
        let pid = self.debugger.pid();
        let thread = self.debugger.current_thread();
        let threads = if exited {
            Vec::new()
        } else {
            self.debugger
                .threads()
                .into_iter()
                .map(|tid| ThreadOut {
                    id: tid.as_raw(),
                    name: yog_debugger::thread_name(pid, tid),
                    stopped: self.debugger.is_stopped(tid),
                })
                .collect()
        };
        let registers = match self.debugger.registers() {
            Ok(r) if !exited => [
                ("rip", r.rip),
                ("rsp", r.rsp),
                ("rbp", r.rbp),
                ("rax", r.rax),
                ("rbx", r.rbx),
                ("rcx", r.rcx),
                ("rdx", r.rdx),
                ("rsi", r.rsi),
                ("rdi", r.rdi),
                ("r8", r.r8),
                ("r9", r.r9),
                ("r10", r.r10),
                ("r11", r.r11),
                ("r12", r.r12),
                ("r13", r.r13),
                ("r14", r.r14),
                ("r15", r.r15),
                ("eflags", r.eflags),
            ]
            .into_iter()
            .map(|(name, value)| (name.to_string(), format!("{value:#018x}")))
            .collect(),
            _ => Vec::new(),
        };
        let _ = app.emit(
            "debug-stopped",
            DebugStoppedEvent {
                reason: reason_str.to_string(),
                stack_trace: if exited {
                    Vec::new()
                } else {
                    self.stack_trace()
                },
                threads,
                thread: thread.as_raw(),
                registers,
            },
        );
    }
}

fn warn(app: &AppHandle, message: String) {
    let _ = app.emit(crate::OUTPUT_DEBUG, format!("[warn] {message}"));
}

/// Mirrors the editor gutter: every breakpoint the user currently has set,
/// whether or not a debug session is attached — kept in sync on every
/// toggle (deduplicated), so a session attaching later (or a second one
/// after Restart) arms exactly what the gutter shows, same as any IDE lets
/// you set breakpoints before pressing Start.
static BREAKPOINTS: Mutex<Vec<(String, u32)>> = Mutex::new(Vec::new());

/// `StackFrameOut::id` = physical frame * this + inline depth.
const FRAME_ID_STRIDE: usize = 64;

/// `std`'s DWARF paths (`/rustc/<commit>/library/...`) mapped into an
/// installed `rust-src`: the toolchain whose `rustc` was built from that
/// commit, else any toolchain that has `rust-src`. Unchanged when nothing
/// matches (the UI then suggests installing `rust-src`).
fn map_rust_src(path: &str) -> String {
    let Some(rest) = path.strip_prefix("/rustc/") else {
        return path.to_string();
    };
    let Some((commit, rel)) = rest.split_once('/') else {
        return path.to_string();
    };
    let Some(rel) = rel.strip_prefix("library/") else {
        return path.to_string();
    };
    static CACHE: Mutex<Option<HashMap<String, Option<PathBuf>>>> = Mutex::new(None);
    let library = CACHE
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .entry(commit.to_string())
        .or_insert_with(|| rust_src_library(commit))
        .clone();
    match library.map(|lib| lib.join(rel)) {
        Some(mapped) if mapped.is_file() => mapped.to_string_lossy().into_owned(),
        _ => path.to_string(),
    }
}

/// `<toolchain>/lib/rustlib/src/rust/library` of the toolchain built from
/// `commit`, or of any toolchain with `rust-src`.
fn rust_src_library(commit: &str) -> Option<PathBuf> {
    let rustup_home = std::env::var_os("RUSTUP_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".rustup")))?;
    let mut toolchains: Vec<PathBuf> = std::fs::read_dir(rustup_home.join("toolchains"))
        .ok()?
        .filter_map(|e| Some(e.ok()?.path()))
        .filter(|t| t.join("lib/rustlib/src/rust/library").is_dir())
        .collect();
    toolchains.sort();
    let built_from = |toolchain: &Path| {
        Command::new(toolchain.join("bin/rustc"))
            .arg("-vV")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .is_some_and(|out| {
                String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .any(|l| l.strip_prefix("commit-hash: ") == Some(commit))
            })
    };
    let toolchain = toolchains
        .iter()
        .find(|t| built_from(t))
        .or(toolchains.first())?;
    Some(toolchain.join("lib/rustlib/src/rust/library"))
}

fn tracer_send(state: &State<DebugState>, cmd: TracerCmd) -> bool {
    let guard = state.inner().0.lock().unwrap();
    guard
        .as_ref()
        .and_then(|s| s.tracer.as_ref())
        .is_some_and(|tracer| tracer.send(cmd))
}

#[tauri::command]
pub fn debug_set_breakpoint(
    state: State<DebugState>,
    file: String,
    line: u32,
) -> Result<(), String> {
    {
        let mut breakpoints = BREAKPOINTS.lock().unwrap();
        if !breakpoints.iter().any(|(f, l)| f == &file && *l == line) {
            breakpoints.push((file.clone(), line));
        }
    }
    // Errors from actually arming it surface in Output from the tracer
    // thread; with no session, remembering it above is all there is to do.
    tracer_send(&state, TracerCmd::SetBreakpoint { file, line });
    Ok(())
}

#[tauri::command]
pub fn debug_clear_breakpoint(
    state: State<DebugState>,
    file: String,
    line: u32,
) -> Result<(), String> {
    BREAKPOINTS
        .lock()
        .unwrap()
        .retain(|(f, l)| !(f == &file && *l == line));
    tracer_send(&state, TracerCmd::ClearBreakpoint { file, line });
    Ok(())
}

#[tauri::command]
pub fn debug_pause(state: State<DebugState>) -> Result<(), String> {
    if tracer_send(&state, TracerCmd::Pause) {
        Ok(())
    } else {
        Err("no active debug session".to_string())
    }
}

#[tauri::command]
pub fn debug_select_thread(state: State<DebugState>, thread: i32) -> Result<(), String> {
    if tracer_send(&state, TracerCmd::SelectThread(thread)) {
        Ok(())
    } else {
        Err("no active debug session".to_string())
    }
}

/// Runs `query` on the tracer thread against the paused tracee and
/// returns its answer. Only answerable while paused — reading a running
/// thread's registers and memory would be meaningless anyway.
async fn tracer_query<T: Send + 'static>(
    state: State<'_, DebugState>,
    query: impl FnOnce(&mut Tracer) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (reply, answer) = mpsc::channel();
    {
        let guard = state.inner().0.lock().unwrap();
        let tracer = guard
            .as_ref()
            .and_then(|s| s.tracer.as_ref())
            .ok_or("no active debug session")?;
        if tracer.running.load(Ordering::SeqCst) {
            return Err("the game is running".to_string());
        }
        let cmd = TracerCmd::Inspect(Box::new(move |t: &mut Tracer| {
            let _ = reply.send(query(t));
        }));
        if !tracer.send(cmd) {
            return Err("no active debug session".to_string());
        }
    }
    // The first lookup parses the native's DWARF units, which can take a
    // moment for a large mod.
    tauri::async_runtime::spawn_blocking(move || {
        answer
            .recv_timeout(Duration::from_secs(20))
            .map_err(|_| "the debugger didn't answer".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Locals of frame `frame` (a `StackFrameOut::id`) of the thread the last
/// `debug-stopped` described, one level deep — expand rows with
/// `debug_children`.
#[tauri::command]
pub async fn debug_variables(
    state: State<'_, DebugState>,
    frame: usize,
) -> Result<Vec<VariableOut>, String> {
    tracer_query(state, move |t| t.variables(frame)).await
}

/// Watch expressions (and DataTips) evaluated in frame `frame`, one result
/// per expression, in order.
#[tauri::command]
pub async fn debug_evaluate(
    state: State<'_, DebugState>,
    frame: usize,
    exprs: Vec<String>,
) -> Result<Vec<WatchOut>, String> {
    tracer_query(state, move |t| t.evaluate(frame, &exprs)).await
}

/// The rows under an expandable row (`VariableOut::handle`) from the
/// current stop.
#[tauri::command]
pub async fn debug_children(
    state: State<'_, DebugState>,
    handle: u64,
) -> Result<Vec<VariableOut>, String> {
    tracer_query(state, move |t| t.children(handle)).await
}

#[tauri::command]
pub fn debug_continue(state: State<DebugState>) -> Result<(), String> {
    tracer_resume(&state, TracerCmd::Continue)
}

/// Continue/Step: rejected unless the tracer is paused (see
/// `TracerHandle::resume`).
fn tracer_resume(state: &State<DebugState>, cmd: TracerCmd) -> Result<(), String> {
    let guard = state.inner().0.lock().unwrap();
    guard
        .as_ref()
        .and_then(|s| s.tracer.as_ref())
        .ok_or("no active debug session")?
        .resume(cmd)
}

/// `kind`: `"over"` (F10, the default), `"into"` (F11) or `"out"`
/// (Shift+F11) — a source-level step, not a single instruction.
#[tauri::command]
pub fn debug_step(state: State<DebugState>, kind: Option<String>) -> Result<(), String> {
    let kind = match kind.as_deref() {
        None | Some("over") => StepKind::Over,
        Some("into") => StepKind::Into,
        Some("out") => StepKind::Out,
        Some(other) => return Err(format!("unknown step kind {other:?}")),
    };
    tracer_resume(&state, TracerCmd::Step(kind))
}

/// Kills the whole instance, whether or not it's a debug-mode run: signals
/// the real pid directly (which also wakes a tracer thread blocked in
/// `waitpid` — and dropping the session closes its command channel, ending
/// one that's waiting on the user instead), then kills the original wrapper
/// process too — a wrapper like Gradle can hand off to a persistent
/// background daemon that outlives `./gradlew` by design, so killing only
/// the real pid is the more reliable half of this, with the wrapper cleanup
/// as a best-effort second step (a lingering Gradle daemon itself is not
/// something this can or should tear down — `gradlew --stop` is the user's
/// own tool for that).
#[tauri::command]
pub fn debug_stop(app: AppHandle, state: State<DebugState>) -> Result<(), String> {
    let session = state.inner().0.lock().unwrap().take();
    let Some(mut session) = session else {
        return Ok(());
    };
    if let Some(pid) = session.real_pid {
        let _ = nix::sys::signal::kill(Pid::from_raw(pid), Signal::SIGKILL);
    }
    drop(session.tracer.take());
    let _ = Command::new("pkill")
        .args(["-P", &session.wrapper.id().to_string()])
        .status();
    let _ = session.wrapper.kill();
    let _ = session.wrapper.wait();

    let _ = app.emit(
        "game-status",
        GameStatus {
            stage: "exited",
            pid: None,
            mods: Vec::new(),
        },
    );
    let _ = app.emit("debug-stopped", DebugStoppedEvent::exited());
    let _ = app.emit("workflow-exit", ());
    Ok(())
}

/// On Yog-IDLE exiting: the game it launched keeps running (see
/// `crate::spawn_yog_run`), so a debug session detaches from it first —
/// otherwise its breakpoints would stay armed with nobody left to handle
/// the trap. Waits briefly; the game itself is never stopped here.
pub fn detach_on_exit(app: &AppHandle) {
    let (done, finished) = mpsc::channel();
    let sent = app
        .state::<DebugState>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|s| s.tracer.as_ref())
        .is_some_and(|tracer| tracer.send(TracerCmd::Detach { done }));
    if sent {
        let _ = finished.recv_timeout(Duration::from_secs(2));
    }
}

/// Why an attach got `EPERM`, and the one thing that fixes it here. Yama
/// (`kernel.yama.ptrace_scope`) only lets a process trace its descendants,
/// and the game isn't one of ours — Gradle's daemon launches it. The
/// runtime lifts that for us when we connect (`PR_SET_PTRACER`, reported as
/// `ready.ptracer`); the messages start with a stable tag the Debug panel
/// keys its actions on.
fn permission_denied_message(pid: i32, ptracer: Option<bool>) -> String {
    let scope = std::fs::read_to_string("/proc/sys/kernel/yama/ptrace_scope")
        .ok()
        .and_then(|s| s.trim().parse::<u8>().ok());
    match (ptracer, scope) {
        (_, Some(3)) => format!(
            "[ptrace-disabled] attaching to pid {pid}: permission denied — ptrace is disabled on this system \
             (kernel.yama.ptrace_scope = 3) until the next reboot; no debugger can attach."
        ),
        (None, Some(0 | 1) | None) => format!(
            "[runtime-outdated] attaching to pid {pid}: permission denied — this game runs a yog-runtime from \
             before it let the IDE trace it (PR_SET_PTRACER). Rebuild the runtime (`./build.sh build rust` in \
             Yog-Mod-Loader, or `./dev.sh`) and launch again."
        ),
        _ => format!(
            "[needs-capability] attaching to pid {pid}: permission denied — kernel.yama.ptrace_scope = {} here, \
             which only lets privileged processes trace. Grant Yog-IDLE the ptrace capability (once), restart it, \
             and launch again.",
            scope.map_or_else(|| "?".to_string(), |s| s.to_string())
        ),
    }
}

/// Restarts Yog-IDLE — after `debug_grant_ptrace_capability`, which only
/// takes effect for a fresh `exec()`.
#[tauri::command]
pub fn app_restart(app: AppHandle) {
    app.restart();
}

/// A capability can only be granted to a binary's on-disk file (checked at
/// `exec()` time) by something already privileged — a running process can
/// never grant *itself* one. So this is the one-time, user-initiated setup
/// step for attaching without needing `ptrace_scope` set to 0 system-wide:
/// `pkexec` (Polkit's graphical sudo-equivalent, standard on GNOME/KDE)
/// prompts for elevation once, then `setcap` stamps `cap_sys_ptrace+ep`
/// onto Yog-IDLE's own executable so every future launch already has it,
/// no repeated prompts. Never called implicitly — only in direct response
/// to the user asking for it (e.g. a "Grant ptrace access" action shown
/// after an `EPERM` attach failure).
#[tauri::command]
pub fn debug_grant_ptrace_capability() -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("couldn't determine Yog-IDLE's own executable path: {e}"))?;
    let status = Command::new("pkexec")
        .arg("setcap")
        .arg("cap_sys_ptrace+ep")
        .arg(&exe)
        .status()
        .map_err(|e| format!("failed to run pkexec (is Polkit installed?): {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "setcap exited with {status} — cancelled, or `setcap`/`pkexec` isn't available. You can also run this manually: sudo setcap cap_sys_ptrace+ep {}",
            exe.display()
        ))
    }
}
