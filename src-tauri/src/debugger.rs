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
use yog_debugger::maps::find_module_base_by_prefix;
use yog_debugger::{Debugger, SourceBreakpoints, StopReason};
use yog_hot_reload::{GenerationAllocator, ModuleGeneration};
use yog_symbols::SymbolTable;

/// Everything the tracer thread owns for one attached debug session — see
/// `tracer_main`. Never leaves that thread.
struct Tracer {
    debugger: Debugger,
    symbols: SymbolTable,
    module_base: u64,
    mod_id: String,
    generation: ModuleGeneration,
    breakpoints: SourceBreakpoints,
}

/// A request for the tracer thread. Breakpoint edits are applied whether
/// the tracee is paused or running (a running one is briefly interrupted —
/// see `TracerHandle::send`); `Continue`/`Step` only mean anything while
/// it's paused.
enum TracerCmd {
    SetBreakpoint { file: String, line: u32 },
    ClearBreakpoint { file: String, line: u32 },
    Continue,
    Step,
}

#[derive(Clone, Copy)]
enum Resume {
    Continue,
    Step,
}

/// The rest of the app's way to reach a debug-mode run's tracer thread.
struct TracerHandle {
    tx: Sender<TracerCmd>,
    pid: i32,
    /// `true` while the tracee is executing and the tracer thread is
    /// blocked in `waitpid` (inside `continue_`/`single_step`) — the only
    /// state in which it can't pick up a command on its own.
    running: Arc<AtomicBool>,
}

impl TracerHandle {
    /// Queues `cmd`; if it's one that has to take effect *now* (a
    /// breakpoint edit) and the tracee is running, also stops the traced
    /// thread with a thread-directed `SIGSTOP` so the tracer's `waitpid`
    /// returns and it can drain its queue — `tracer_main` treats that stop
    /// as its own and resumes straight afterward. Returns `false` once the
    /// tracer thread is gone.
    fn send(&self, cmd: TracerCmd) -> bool {
        let urgent = matches!(cmd, TracerCmd::SetBreakpoint { .. } | TracerCmd::ClearBreakpoint { .. });
        if self.tx.send(cmd).is_err() {
            return false;
        }
        if urgent && self.running.load(Ordering::SeqCst) {
            // `tgkill`, not `kill`: a process-directed SIGSTOP would
            // group-stop every (untraced) thread of the JVM, and nothing
            // here would ever SIGCONT them again.
            // SAFETY: a plain syscall taking only integer arguments.
            unsafe {
                nix::libc::syscall(nix::libc::SYS_tgkill, self.pid, self.pid, nix::libc::SIGSTOP);
            }
        }
        true
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
    real_pid: Option<i32>,
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
}

fn to_snake_name(id: &str) -> String {
    // Mirrors yog-cli's own `to_snake_name` exactly — the native's lib name
    // (and therefore its filename) is derived this way, and Yog-IDLE has to
    // agree with yog-cli's convention to find the same file on disk.
    let mut out = String::with_capacity(id.len());
    for c in id.chars() {
        if c == '-' || c == '_' {
            if out.chars().last() != Some('_') {
                out.push('_');
            }
        } else if c.is_uppercase() {
            if !out.is_empty() && out.chars().last() != Some('_') {
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
        if let Some(value) = line.strip_prefix("id").and_then(|rest| rest.trim_start().strip_prefix('=')) {
            return Some(value.trim().trim_matches('"').to_string());
        }
    }
    None
}

/// The local, just-built unstripped native's path — `target/<triple>/
/// release/<lib>`, exactly how `yog-cli`'s `Builder`/`package()` name it for
/// the host platform. Not the runtime-extracted temp copy (unpredictable —
/// see `find_module_base_by_prefix`'s doc comment) — this is only used for
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
    project_root.join("target").join(triple).join("release").join(lib)
}

fn control_socket_path() -> PathBuf {
    std::env::temp_dir().join(format!("yog-idle-{}-{}.sock", std::process::id(), std::time::SystemTime::now().elapsed_or_zero_nanos()))
}

// `SystemTime` has no direct "nanos since some fixed point" accessor without
// a fallible `duration_since` — this just makes the call site above read
// cleanly instead of unwrapping inline.
trait ElapsedOrZero {
    fn elapsed_or_zero_nanos(&self) -> u128;
}
impl ElapsedOrZero for std::time::SystemTime {
    fn elapsed_or_zero_nanos(&self) -> u128 {
        self.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
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
pub fn run_with_mode(app: AppHandle, project_root: String, config_name: String, mode: String) -> Result<(), String> {
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

    let mut child = Command::new("yog")
        .args(&args)
        .current_dir(&root)
        .env("YOG_CONTROL_SOCKET", &socket_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch `yog run {config_name}`: {e}"))?;

    for pipe_kind in ["stdout", "stderr"] {
        let out_app = app.clone();
        if pipe_kind == "stdout" {
            if let Some(stdout) = child.stdout.take() {
                std::thread::spawn(move || {
                    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                        let _ = out_app.emit("workflow-output", line);
                    }
                });
            }
        } else if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let _ = out_app.emit("workflow-output", format!("[warn] {line}"));
                }
            });
        }
    }

    let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    *app.state::<DebugState>().0.lock().unwrap() = Some(RunSession { id, wrapper: child, real_pid: None, tracer: None });
    let _ = app.emit("game-status", GameStatus { stage: "starting", pid: None, mods: Vec::new() });

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
fn connect_and_watch(app: AppHandle, session_id: u64, socket_path: PathBuf, mod_id: String, debug: bool, native_path: PathBuf) {
    let connect_deadline = Instant::now() + Duration::from_secs(90);
    let stream = loop {
        match UnixStream::connect(&socket_path) {
            Ok(s) => break Some(s),
            Err(_) if Instant::now() < connect_deadline => std::thread::sleep(Duration::from_millis(200)),
            Err(_) => break None,
        }
    };

    let Some(mut stream) = stream else {
        // Not fatal for a plain run — an older yog-runtime without socket
        // support, or a mod that never got as far as `nativeInit`, just
        // means no live status/attach for this session, not that the game
        // itself failed to launch.
        let _ = app.emit(
            "workflow-output",
            "[warn] control socket never connected — no live status or debugger attach available for this run".to_string(),
        );
        if debug {
            emit_failed(&app, "control socket never connected — is this mod's yog-runtime new enough to support it?");
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
    let Ok(ready) = serde_json::from_str::<serde_json::Value>(line.trim()) else { return };
    let Some(real_pid) = ready.get("pid").and_then(|v| v.as_i64()).map(|v| v as i32) else { return };
    let mods: Vec<ModInfoOut> = ready
        .get("mods")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|m| ModInfoOut {
                    id: m.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                    name: m.get("name").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                    version: m.get("version").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();

    {
        let debug_state = app.state::<DebugState>();
        let mut guard = debug_state.0.lock().unwrap();
        match guard.as_mut() {
            Some(session) if session.id == session_id => session.real_pid = Some(real_pid),
            // Stopped (or restarted) before the game even reported in.
            _ => return,
        }
    }
    let _ = app.emit("game-status", GameStatus { stage: "ready", pid: Some(real_pid), mods });

    if debug {
        start_tracer(&app, session_id, real_pid, mod_id, native_path);
    }

    // Keep reading further event lines (hot-reload-done, ...) for the rest
    // of the session — a plain forward into `game-status`, same shape as
    // the `ready` handling above. When the game process exits (however it
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
                    let stage = event.get("event").and_then(|v| v.as_str()).unwrap_or("unknown");
                    let _ = app.emit("workflow-output", format!("[control] {stage}: {line}", line = line.trim()));
                }
            }
        }
    }
    let _ = stream.flush();
    mark_exited(&app, session_id);
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
        let _ = app.emit("game-status", GameStatus { stage: "exited", pid: None, mods: Vec::new() });
        let _ = app.emit("debug-stopped", DebugStoppedEvent { reason: "exited".to_string(), stack_trace: Vec::new() });
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
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let debug_state = app.state::<DebugState>();
        let mut guard = debug_state.0.lock().unwrap();
        let Some(session) = guard.as_mut().filter(|s| s.id == session_id) else { return };
        match session.wrapper.try_wait() {
            Ok(Some(_)) => {
                drop(guard);
                mark_exited(&app, session_id);
                return;
            }
            Ok(None) => continue,
            Err(_) => return,
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
    let _ = app.emit("workflow-output", format!("[error] debug: {message}"));
}

/// Registers a `TracerHandle` on the session (so breakpoint toggles made
/// while attach is still in progress queue up instead of being lost) and
/// spawns the tracer thread itself.
fn start_tracer(app: &AppHandle, session_id: u64, real_pid: i32, mod_id: String, native_path: PathBuf) {
    let (tx, rx) = mpsc::channel();
    let running = Arc::new(AtomicBool::new(false));
    {
        let debug_state = app.state::<DebugState>();
        let mut guard = debug_state.0.lock().unwrap();
        match guard.as_mut() {
            Some(session) if session.id == session_id => {
                session.tracer = Some(TracerHandle { tx, pid: real_pid, running: running.clone() });
            }
            _ => return,
        }
    }
    let app = app.clone();
    std::thread::spawn(move || tracer_main(app, real_pid, mod_id, native_path, rx, running));
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
fn tracer_main(app: AppHandle, real_pid: i32, mod_id: String, native_path: PathBuf, rx: Receiver<TracerCmd>, running: Arc<AtomicBool>) {
    let mut tracer = match Tracer::attach(&app, real_pid, &mod_id, &native_path) {
        Ok(t) => t,
        Err(e) => {
            emit_failed(&app, e);
            return;
        }
    };
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
            running.store(true, Ordering::SeqCst);
            let result = match kind {
                Resume::Continue => tracer.debugger.continue_(),
                Resume::Step => tracer.debugger.single_step(),
            };
            running.store(false, Ordering::SeqCst);
            match result {
                // Our own interrupt (see `TracerHandle::send`): apply what
                // was queued and carry on with whatever was in progress.
                Ok(StopReason::Signal(Signal::SIGSTOP)) => {
                    while let Ok(cmd) = rx.try_recv() {
                        tracer.apply(&app, cmd);
                    }
                    resume = Some(kind);
                    continue;
                }
                Ok(reason) => {
                    let exited = matches!(reason, StopReason::Exited(_) | StopReason::Killed(_));
                    tracer.emit_stop(&app, reason);
                    if exited {
                        return;
                    }
                }
                Err(e) => {
                    emit_failed(&app, e.to_string());
                    break;
                }
            }
        }
        // Paused — wait for the user. The channel closing means the
        // session itself is gone (Stop, or the game exiting).
        match rx.recv() {
            Ok(TracerCmd::Continue) => resume = Some(Resume::Continue),
            Ok(TracerCmd::Step) => resume = Some(Resume::Step),
            Ok(cmd) => tracer.apply(&app, cmd),
            Err(_) => break,
        }
    }
    let _ = tracer.debugger.detach();
}

impl Tracer {
    fn attach(app: &AppHandle, real_pid: i32, mod_id: &str, native_path: &Path) -> Result<Self, String> {
        let symbols = SymbolTable::load(native_path).map_err(|e| format!("loading symbols from {}: {e}", native_path.display()))?;
        let mut debugger = Debugger::attach(real_pid).map_err(|e| {
            let raw = e.to_string();
            if raw.contains("EPERM") {
                format!(
                    "attaching to pid {real_pid}: permission denied. Linux's ptrace security policy (Yama) only allows a process \
                     to attach to its own descendants by default — the game process the control socket found is very likely not \
                     a descendant of Yog-IDLE (e.g. an existing Gradle daemon reused across launches). Either run \
                     `echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope` (session-only, resets on reboot) or grant Yog-IDLE's \
                     own binary the capability directly: `sudo setcap cap_sys_ptrace+ep <path to the yog-idle binary>` — either \
                     way, a capability granted to the binary only takes effect the *next* time Yog-IDLE itself is launched, not \
                     the currently-running instance, so restart it before trying again."
                )
            } else {
                format!("attaching to pid {real_pid}: {raw}")
            }
        })?;
        let prefix = format!("yog-{mod_id}-");
        let Some(module_base) = find_module_base_by_prefix(debugger.pid(), &prefix) else {
            // Attached but unusable — let the game go rather than leaving
            // it stopped.
            let _ = debugger.detach();
            return Err(format!("couldn't locate {mod_id}'s native in pid {real_pid}'s memory map"));
        };

        let mut tracer = Tracer {
            debugger,
            symbols,
            module_base,
            mod_id: mod_id.to_string(),
            generation: GenerationAllocator::new().next(),
            breakpoints: SourceBreakpoints::new(),
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
                if let Err(e) = self.breakpoints.clear(&mut self.debugger, &self.mod_id, &file, line) {
                    warn(app, format!("clearing breakpoint {file}:{line}: {e}"));
                }
            }
            // Only meaningful while paused, where `tracer_main` handles
            // them itself — one arriving mid-run is a stale double-click.
            TracerCmd::Continue | TracerCmd::Step => {}
        }
    }

    /// Arms `file:line` unless it's already tracked (`SourceBreakpoints`
    /// itself would happily track a duplicate), reporting both outright
    /// failures and lines that don't map to any code in the native.
    fn set_breakpoint(&mut self, app: &AppHandle, file: String, line: u32) {
        if self.breakpoints.all().iter().any(|bp| bp.file == file && bp.line == line) {
            return;
        }
        match self.breakpoints.set(&mut self.debugger, &self.mod_id, self.generation, self.module_base, &self.symbols, &file, line) {
            Err(e) => warn(app, format!("setting breakpoint {file}:{line}: {e}")),
            Ok(()) => {
                if self.breakpoints.all().last().is_some_and(|bp| bp.addr.is_none()) {
                    warn(app, format!("breakpoint {file}:{line} doesn't map to any code in {}'s native — it won't be hit", self.mod_id));
                }
            }
        }
    }

    fn stack_trace(&self) -> Vec<StackFrameOut> {
        let Ok(addrs) = self.debugger.backtrace(64) else { return Vec::new() };
        addrs
            .into_iter()
            .enumerate()
            .filter_map(|(i, addr)| {
                let offset = addr.checked_sub(self.module_base)?;
                let location = self.symbols.resolve_addr(offset)?;
                Some(StackFrameOut {
                    id: i as i64,
                    name: location.function.unwrap_or_else(|| "<unknown>".to_string()),
                    file: location.file.to_string_lossy().into_owned(),
                    line: location.line,
                })
            })
            .collect()
    }

    fn emit_stop(&self, app: &AppHandle, reason: StopReason) {
        let reason_str = match reason {
            StopReason::Breakpoint(_) => "breakpoint",
            StopReason::Signal(_) => "signal",
            StopReason::Exited(_) | StopReason::Killed(_) => "exited",
        };
        let stack_trace = if reason_str == "exited" { Vec::new() } else { self.stack_trace() };
        let _ = app.emit("debug-stopped", DebugStoppedEvent { reason: reason_str.to_string(), stack_trace });
    }
}

fn warn(app: &AppHandle, message: String) {
    let _ = app.emit("workflow-output", format!("[warn] debug: {message}"));
}

/// Mirrors the editor gutter: every breakpoint the user currently has set,
/// whether or not a debug session is attached — kept in sync on every
/// toggle (deduplicated), so a session attaching later (or a second one
/// after Restart) arms exactly what the gutter shows, same as any IDE lets
/// you set breakpoints before pressing Start.
static BREAKPOINTS: Mutex<Vec<(String, u32)>> = Mutex::new(Vec::new());

fn tracer_send(state: &State<DebugState>, cmd: TracerCmd) -> bool {
    let guard = state.inner().0.lock().unwrap();
    guard.as_ref().and_then(|s| s.tracer.as_ref()).is_some_and(|tracer| tracer.send(cmd))
}

#[tauri::command]
pub fn debug_set_breakpoint(state: State<DebugState>, file: String, line: u32) -> Result<(), String> {
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
pub fn debug_clear_breakpoint(state: State<DebugState>, file: String, line: u32) -> Result<(), String> {
    BREAKPOINTS.lock().unwrap().retain(|(f, l)| !(f == &file && *l == line));
    tracer_send(&state, TracerCmd::ClearBreakpoint { file, line });
    Ok(())
}

#[tauri::command]
pub fn debug_continue(state: State<DebugState>) -> Result<(), String> {
    if tracer_send(&state, TracerCmd::Continue) { Ok(()) } else { Err("no active debug session".to_string()) }
}

#[tauri::command]
pub fn debug_step(state: State<DebugState>) -> Result<(), String> {
    if tracer_send(&state, TracerCmd::Step) { Ok(()) } else { Err("no active debug session".to_string()) }
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
    let Some(mut session) = session else { return Ok(()) };
    if let Some(pid) = session.real_pid {
        let _ = nix::sys::signal::kill(Pid::from_raw(pid), Signal::SIGKILL);
    }
    drop(session.tracer.take());
    let _ = Command::new("pkill").args(["-P", &session.wrapper.id().to_string()]).status();
    let _ = session.wrapper.kill();
    let _ = session.wrapper.wait();

    let _ = app.emit("game-status", GameStatus { stage: "exited", pid: None, mods: Vec::new() });
    let _ = app.emit("debug-stopped", DebugStoppedEvent { reason: "exited".to_string(), stack_trace: Vec::new() });
    let _ = app.emit("workflow-exit", ());
    Ok(())
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
    let exe = std::env::current_exe().map_err(|e| format!("couldn't determine Yog-IDLE's own executable path: {e}"))?;
    let status = Command::new("pkexec")
        .arg("setcap")
        .arg("cap_sys_ptrace+ep")
        .arg(&exe)
        .status()
        .map_err(|e| format!("failed to run pkexec (is Polkit installed?): {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("setcap exited with {status} — cancelled, or `setcap`/`pkexec` isn't available. You can also run this manually: sudo setcap cap_sys_ptrace+ep {}", exe.display()))
    }
}
