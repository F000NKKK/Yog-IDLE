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
use std::sync::Mutex;
use std::time::{Duration, Instant};

use nix::unistd::Pid;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use yog_debugger::maps::find_module_base_by_prefix;
use yog_debugger::{Debugger, SourceBreakpoints, StopReason};
use yog_hot_reload::{GenerationAllocator, ModuleGeneration};
use yog_symbols::SymbolTable;

struct DebugBits {
    debugger: Debugger,
    symbols: SymbolTable,
    module_base: u64,
    mod_id: String,
    generation: ModuleGeneration,
    breakpoints: SourceBreakpoints,
}

/// One `yog run` launch — always present while the process is up, whether
/// or not it's a debug-mode run. `debug` is only `Some` once a debug-mode
/// run has actually attached.
pub struct RunSession {
    wrapper: Child,
    real_pid: Option<i32>,
    debug: Option<DebugBits>,
}

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

    *app.state::<DebugState>().0.lock().unwrap() = Some(RunSession { wrapper: child, real_pid: None, debug: None });
    let _ = app.emit("game-status", GameStatus { stage: "starting", pid: None, mods: Vec::new() });

    spawn_exit_watcher(app.clone());
    std::thread::spawn(move || connect_and_watch(app, socket_path, mod_id, debug, native_path));
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
fn connect_and_watch(app: AppHandle, socket_path: PathBuf, mod_id: String, debug: bool, native_path: PathBuf) {
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

    if let Some(session) = app.state::<DebugState>().0.lock().unwrap().as_mut() {
        session.real_pid = Some(real_pid);
    }
    *ACTIVE_PID.lock().unwrap() = Some(real_pid);
    let _ = app.emit("game-status", GameStatus { stage: "ready", pid: Some(real_pid), mods });

    if debug {
        if let Err(e) = try_attach(&app, real_pid, &mod_id, &native_path) {
            emit_failed(&app, e);
        }
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
    mark_exited(&app);
}

/// Clears whatever's left of the session and reports "the game is gone" —
/// called both when the control socket drops (the common, prompt path) and
/// by `spawn_exit_watcher`'s `try_wait` polling (the backstop for a run
/// whose socket never connected in the first place, e.g. an older
/// `yog-runtime` without control-socket support). Safe to call more than
/// once — a session that's already gone is simply a no-op.
fn mark_exited(app: &AppHandle) {
    *ACTIVE_PID.lock().unwrap() = None;
    let had_session = state_has_session(app);
    *app.state::<DebugState>().0.lock().unwrap() = None;
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

fn state_has_session(app: &AppHandle) -> bool {
    app.state::<DebugState>().0.lock().unwrap().is_some()
}

/// Backstop for detecting the game exiting when the control socket never
/// connected at all (so `connect_and_watch`'s own read loop never got a
/// chance to notice the drop): polls the spawned wrapper process
/// non-blockingly every second and reports "exited" the moment it's gone —
/// whether that's the user closing the client themselves, a crash, or
/// `debug_stop`. Exits its own loop once the session is gone by any means
/// (this watcher's own detection, or `connect_and_watch`'s).
fn spawn_exit_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let debug_state = app.state::<DebugState>();
        let mut guard = debug_state.0.lock().unwrap();
        let Some(session) = guard.as_mut() else { return };
        match session.wrapper.try_wait() {
            Ok(Some(_)) => {
                drop(guard);
                mark_exited(&app);
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

fn try_attach(app: &AppHandle, real_pid: i32, mod_id: &str, native_path: &Path) -> Result<(), String> {
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
    let module_base =
        find_module_base_by_prefix(debugger.pid(), &prefix).ok_or_else(|| format!("couldn't locate {mod_id}'s native in pid {real_pid}'s memory map"))?;

    let generation = GenerationAllocator::new().next();
    let mut breakpoints = SourceBreakpoints::new();
    for (file, line) in PENDING_BREAKPOINTS.lock().unwrap().iter().cloned().collect::<Vec<_>>() {
        let _ = breakpoints.set(&mut debugger, mod_id, generation, module_base, &symbols, &file, line);
    }

    let debug_bits = DebugBits { debugger, symbols, module_base, mod_id: mod_id.to_string(), generation, breakpoints };
    if let Some(session) = app.state::<DebugState>().0.lock().unwrap().as_mut() {
        session.debug = Some(debug_bits);
    }

    let _ = app.emit("debug-attached", real_pid);
    Ok(())
}

/// The pid `debug_stop` signals directly, kept outside `DebugState`'s own
/// mutex on purpose: `debug_continue`/`debug_step` hold that mutex (via
/// `Option::take`) for as long as the tracee is actually running — which
/// can be indefinite — so `debug_stop` needs a way to interrupt a running
/// target that doesn't depend on acquiring the same lock. Killing the real
/// process also naturally unblocks whatever `waitpid` call is in flight,
/// which is what lets a "continue" in progress actually stop.
static ACTIVE_PID: Mutex<Option<i32>> = Mutex::new(None);

/// Breakpoints requested before a debug session is attached — applied the
/// moment attach succeeds, same as any IDE lets you set breakpoints before
/// pressing Start.
static PENDING_BREAKPOINTS: Mutex<Vec<(String, u32)>> = Mutex::new(Vec::new());

#[tauri::command]
pub fn debug_set_breakpoint(state: State<DebugState>, file: String, line: u32) -> Result<(), String> {
    let mut guard = state.inner().0.lock().unwrap();
    match guard.as_mut().and_then(|s| s.debug.as_mut()) {
        Some(bits) => bits.breakpoints.set(&mut bits.debugger, &bits.mod_id, bits.generation, bits.module_base, &bits.symbols, &file, line).map_err(|e| e.to_string()),
        None => {
            PENDING_BREAKPOINTS.lock().unwrap().push((file, line));
            Ok(())
        }
    }
}

#[tauri::command]
pub fn debug_clear_breakpoint(state: State<DebugState>, file: String, line: u32) -> Result<(), String> {
    let mut guard = state.inner().0.lock().unwrap();
    match guard.as_mut().and_then(|s| s.debug.as_mut()) {
        Some(bits) => bits.breakpoints.clear(&mut bits.debugger, &bits.mod_id, &file, line).map_err(|e| e.to_string()),
        None => {
            PENDING_BREAKPOINTS.lock().unwrap().retain(|(f, l)| !(f == &file && *l == line));
            Ok(())
        }
    }
}

fn stack_trace_of(bits: &DebugBits) -> Vec<StackFrameOut> {
    let Ok(addrs) = bits.debugger.backtrace(64) else { return Vec::new() };
    addrs
        .into_iter()
        .enumerate()
        .filter_map(|(i, addr)| {
            let offset = addr.checked_sub(bits.module_base)?;
            let location = bits.symbols.resolve_addr(offset)?;
            Some(StackFrameOut {
                id: i as i64,
                name: location.function.unwrap_or_else(|| "<unknown>".to_string()),
                file: location.file.to_string_lossy().into_owned(),
                line: location.line,
            })
        })
        .collect()
}

fn emit_stop(app: &AppHandle, bits: &DebugBits, reason: StopReason) {
    let reason_str = match reason {
        StopReason::Breakpoint(_) => "breakpoint",
        StopReason::Signal(_) => "signal",
        StopReason::Exited(_) | StopReason::Killed(_) => "exited",
    };
    let stack_trace = if reason_str == "exited" { Vec::new() } else { stack_trace_of(bits) };
    let _ = app.emit("debug-stopped", DebugStoppedEvent { reason: reason_str.to_string(), stack_trace });
}

/// Takes the whole `RunSession` out of `DebugState` (so the mutex is free
/// for `debug_stop`/`debug_set_breakpoint` to at least *observe* "nothing
/// to act on" instead of deadlocking) and runs `op` — `Debugger::continue_`
/// or `single_step`, both of which block on `waitpid` for as long as the
/// tracee keeps running — on a background thread. The session goes back
/// into `DebugState` afterward unless the tracee exited.
fn run_in_background(app: AppHandle, state: State<DebugState>, op: impl FnOnce(&mut Debugger) -> Result<StopReason, yog_debugger::DebugError> + Send + 'static) -> Result<(), String> {
    let mut guard = state.inner().0.lock().unwrap();
    if guard.as_ref().and_then(|s| s.debug.as_ref()).is_none() {
        return Err("no active debug session".to_string());
    }
    let mut session = guard.take().unwrap();
    drop(guard);
    std::thread::spawn(move || {
        let mut bits = session.debug.take().expect("checked above");
        match op(&mut bits.debugger) {
            Ok(reason) => {
                let exited = matches!(reason, StopReason::Exited(_) | StopReason::Killed(_));
                emit_stop(&app, &bits, reason);
                session.debug = if exited { None } else { Some(bits) };
                if !exited {
                    *ACTIVE_PID.lock().unwrap() = Some(session.real_pid.unwrap_or_default());
                }
                *app.state::<DebugState>().0.lock().unwrap() = Some(session);
            }
            Err(e) => {
                let _ = app.emit("debug-attach-failed", e.to_string());
                *app.state::<DebugState>().0.lock().unwrap() = Some(session);
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn debug_continue(app: AppHandle, state: State<DebugState>) -> Result<(), String> {
    run_in_background(app, state, |debugger| debugger.continue_())
}

#[tauri::command]
pub fn debug_step(app: AppHandle, state: State<DebugState>) -> Result<(), String> {
    run_in_background(app, state, |debugger| debugger.single_step())
}

/// Kills the whole instance, whether or not it's a debug-mode run: signals
/// the real pid directly (this is the only thing that can interrupt a
/// `debug_continue`/`debug_step` currently blocked in `waitpid` on a
/// background thread, which is why it doesn't depend on acquiring
/// `DebugState`'s mutex), detaches cleanly if a debugger is attached, and
/// kills the original wrapper process too — a wrapper like Gradle can hand
/// off to a persistent background daemon that outlives `./gradlew` by
/// design, so killing only the real pid discovery found is the more
/// reliable half of this, with the wrapper cleanup as a best-effort second
/// step (a lingering Gradle daemon itself is not something this can or
/// should tear down — `gradlew --stop` is the user's own tool for that).
#[tauri::command]
pub fn debug_stop(app: AppHandle, state: State<DebugState>) -> Result<(), String> {
    if let Some(pid) = ACTIVE_PID.lock().unwrap().take() {
        let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), nix::sys::signal::Signal::SIGKILL);
    }

    let had_session = state.inner().0.lock().unwrap().take().map(|mut session| {
        if let Some(mut bits) = session.debug.take() {
            let _ = bits.debugger.detach();
        }
        if let Some(pid) = session.real_pid {
            let _ = nix::sys::signal::kill(Pid::from_raw(pid), nix::sys::signal::Signal::SIGKILL);
        }
        let _ = Command::new("pkill").args(["-P", &session.wrapper.id().to_string()]).status();
        let _ = session.wrapper.kill();
        let _ = session.wrapper.wait();
    });

    if had_session.is_some() {
        let _ = app.emit("game-status", GameStatus { stage: "exited", pid: None, mods: Vec::new() });
        let _ = app.emit("debug-stopped", DebugStoppedEvent { reason: "exited".to_string(), stack_trace: Vec::new() });
        let _ = app.emit("workflow-exit", ());
    }
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
