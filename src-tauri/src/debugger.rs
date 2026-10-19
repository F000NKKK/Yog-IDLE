//! Runs a mod via `yog run <config> [--debug --dev]` and connects to the
//! control channel `yog-runtime` opens (dev builds) when `YOG_CONTROL_SOCKET`
//! (a loopback address) and `YOG_CONTROL_TOKEN` are set — see
//! `Yog-Mod-Loader/rust/crates/yog-runtime/src/control_socket.rs`. It's what
//! tells Yog-IDLE the real game pid and what's happening inside it (a
//! launcher wrapper like `./gradlew` is often not even an ancestor of the
//! real JVM once Gradle's daemon is involved). Loopback TCP: every platform.
//!
//! "Debug" isn't a separately-triggered action — it's a `mode` on the
//! normal run flow (`"release"` | `"debug"`, Yog-IDLE's own vocabulary,
//! opaque to `RunBar`): a debug-mode run builds with debug symbols and for
//! hot reload (`--dev`), and on Linux attaches `yog-debugger` the moment the
//! channel's `ready` message gives us a trustworthy pid (`trace`).
//!
//! The same channel carries hot reload the other way: `hot_reload` rebuilds
//! the project and asks the runtime to swap in the new `.yog` in place.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};


#[cfg(target_os = "linux")]
mod trace;
#[cfg(target_os = "linux")]
pub use trace::*;
#[cfg(not(target_os = "linux"))]
pub use no_trace::*;

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
    control: Option<TcpStream>,
    /// Set while a request waits for the runtime's answer: the event it
    /// waits for (`hot-reload-done`, `hot-reload-check`) and where it goes.
    reply_waiter: Option<(&'static str, Sender<serde_json::Value>)>,
    #[cfg(target_os = "linux")]
    tracer: Option<TracerHandle>,
}

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct DebugState(pub Mutex<Option<RunSession>>);

/// A frame of the call stack a stop shows (the same on every platform; only
/// Linux fills it so far).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackFrameOut {
    pub id: i64,
    pub name: String,
    pub file: String,
    pub line: u32,
}

/// A thread of the tracee, as a stop lists it.
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

/// `[mod] id` of the mod at `root`.
fn mod_id(root: &Path) -> Result<String, String> {
    crate::cli::mod_id(root).ok_or_else(|| format!("{} has no mod id", yog_ids::file::MANIFEST))
}

/// How long a write to the control socket may block.
const CONTROL_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a hot reload waits for the game's answer.
const HOT_RELOAD_TIMEOUT: Duration = Duration::from_secs(60);

/// One request line to the control socket, in a single write.
fn send_control(control: &mut TcpStream, request: &serde_json::Value) -> std::io::Result<()> {
    let mut line = request.to_string();
    line.push('\n');
    control.write_all(line.as_bytes())
}

/// Where the game's control channel listens and the token that opens it:
/// a free loopback port (bound and let go — the game binds it next), and
/// random bytes no other process has seen.
fn control_endpoint() -> Result<(String, String), String> {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map_err(|e| format!("no free port for the game's control channel: {e}"))?
        .port();
    // Std's hasher keys are seeded from the OS's randomness.
    use std::hash::{BuildHasher, Hasher};
    let token: String = (0..3)
        .map(|i| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u64(i);
            format!("{:016x}", h.finish())
        })
        .collect();
    Ok((format!("127.0.0.1:{port}"), token))
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
    let mod_id = mod_id(&root)?;
    let debug = mode == "debug";
    #[cfg(target_os = "linux")]
    let native_path = local_native_path(&root, &mod_id);
    let (control_addr, control_token) = control_endpoint()?;

    let mut args = vec!["run".to_string(), config_name.clone()];
    // A Debug run is the one that hot-reloads (`--dev`); a Release run is
    // built as players get it, nothing of hot reload in it.
    if debug {
        args.push("--debug".to_string());
        args.push("--dev".to_string());
    }

    let (child, log) = crate::spawn_yog_run(
        crate::cli::command()
            .args(&args)
            .current_dir(&root)
            .env("YOG_CONTROL_SOCKET", &control_addr)
            .env("YOG_CONTROL_TOKEN", &control_token),
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
        reply_waiter: None,
        #[cfg(target_os = "linux")]
        tracer: None,
    });
    let _ = app.emit(
        crate::events::GAME_STATUS,
        GameStatus {
            stage: "starting",
            pid: None,
            mods: Vec::new(),
        },
    );

    spawn_exit_watcher(app.clone(), id);
    let attach = Attach {
        mod_id,
        debug,
        #[cfg(target_os = "linux")]
        native_path,
    };
    std::thread::spawn(move || connect_and_watch(app, id, control_addr, control_token, attach));
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
/// What a Debug run attaches the debugger to, once the game reports in.
struct Attach {
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    mod_id: String,
    debug: bool,
    #[cfg(target_os = "linux")]
    native_path: PathBuf,
}

fn connect_and_watch(app: AppHandle, session_id: u64, addr: String, token: String, attach: Attach) {
    let debug = attach.debug;
    // No fixed deadline: before the game starts, `yog run` builds the mod
    // (and refreshes the others it exported), and Gradle may build the
    // runtime — minutes, not seconds. Waits for as long as the run lives.
    let alive = || {
        let state = app.state::<DebugState>();
        let guard = state.0.lock().unwrap();
        guard.as_ref().is_some_and(|s| s.id == session_id)
    };
    let stream = loop {
        match TcpStream::connect(&addr) {
            Ok(s) => break Some(s),
            Err(_) if alive() => std::thread::sleep(Duration::from_millis(200)),
            Err(_) => break None,
        }
    };

    let Some(stream) = stream else {
        // The run ended before the game opened the socket (a failed build,
        // a crash at startup) — its own output says why.
        let _ = app.emit(
            crate::events::OUTPUT_DEBUG,
            "[warn] the run ended before the game opened its control socket — see the Build output".to_string(),
        );
        if debug {
            emit_failed(
                &app,
                "the run ended before the game started — nothing to attach to",
            );
        }
        return;
    };

    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });
    // We're the launcher: the token says so, our pid is who may trace the game.
    let mut hello_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    if send_control(&mut hello_stream, &serde_json::json!({ "cmd": "hello", "token": token, "pid": std::process::id() })).is_err() {
        return;
    }

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
                // Written under `DebugState`'s lock: a game that stops reading mustn't wedge every command.
                if let Some(control) = &session.control {
                    let _ = control.set_write_timeout(Some(CONTROL_WRITE_TIMEOUT));
                }
            }
            // Stopped (or restarted) before the game even reported in.
            _ => return,
        }
    }
    let _ = app.emit(
        crate::events::GAME_STATUS,
        GameStatus {
            stage: "ready",
            pid: Some(real_pid),
            mods,
        },
    );

    #[cfg(target_os = "linux")]
    if debug {
        start_tracer(&app, session_id, real_pid, attach.mod_id, attach.native_path, ptracer);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = ptracer;

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
    let name = event.get("event").and_then(|v| v.as_str());
    // An answer someone's waiting for.
    {
        let debug_state = app.state::<DebugState>();
        let mut guard = debug_state.0.lock().unwrap();
        if let Some(session) = guard.as_mut().filter(|s| s.id == session_id)
            && session.reply_waiter.as_ref().is_some_and(|(want, _)| Some(*want) == name)
            && let Some((_, waiter)) = session.reply_waiter.take()
        {
            let _ = waiter.send(event.clone());
            return;
        }
    }
    match name {
        Some("mods") => {
            let _ = app.emit(
                crate::events::GAME_STATUS,
                GameStatus {
                    stage: "ready",
                    pid: Some(real_pid),
                    mods: parse_mods(event),
                },
            );
        }
        other => {
            let _ = app.emit(
                crate::events::OUTPUT_DEBUG,
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
    /// `stage == "confirm"`: what the new build registers that only a
    /// restart applies — `<kind> <id>` each.
    #[serde(skip_serializing_if = "Option::is_none")]
    changes: Option<RegistrationChanges>,
}

#[derive(Clone, Serialize, Default)]
pub struct RegistrationChanges {
    added: Vec<String>,
    removed: Vec<String>,
    changed: Vec<String>,
}

impl RegistrationChanges {
    fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.changed.is_empty()
    }
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
        crate::events::OUTPUT_BUILD,
        format!("{prefix}hot reload: {message}"),
    );
    let _ = app.emit(
        crate::events::HOT_RELOAD,
        HotReloadEvent {
            stage,
            mod_id: mod_id.to_string(),
            ok,
            message,
            changes: None,
        },
    );
}

/// Rebuilds the open project (`yog build`, or `yog build debug` for a
/// debug-mode run) and asks the running game to hot-reload it over the
/// control socket: `{"cmd":"hot_reload","mod_id",..,"yog_path":..}`,
/// answered by `{"event":"hot-reload-done","ok":..}`. The runtime only
/// accepts a `.yog` of its ABI major and a minor no newer than its own.
/// Only in a Debug run: what only a restart applies is checked first, and
/// the user decides (the `confirm` stage, [`decide_hot_reload`]).
///
/// Returns once the work is started — progress and the outcome arrive as
/// `hot-reload` events (plus Output lines), same reasoning as
/// `run_with_mode`'s about not blocking an invoke on a long-running wait.
pub fn hot_reload(app: AppHandle, project_root: String) -> Result<(), String> {
    let root = PathBuf::from(&project_root);
    let mod_id = mod_id(&root)?;

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
    if !debug_mode {
        return Err("hot reload works in a Debug run — a Release run is built as players get it, without it".to_string());
    }
    if HOT_RELOAD_BUSY.swap(true, Ordering::SeqCst) {
        return Err("a hot reload is already in progress".to_string());
    }

    std::thread::spawn(move || {
        let outcome = run_hot_reload(&app, &root, &mod_id, session_id, debug_mode);
        finish_hot_reload(&app, &mod_id, outcome);
    });
    Ok(())
}

/// A built `.yog` waiting for the user: it registers what only a restart applies.
struct PendingReload {
    mod_id: String,
    session_id: u64,
    yog_path: PathBuf,
}

static PENDING_RELOAD: Mutex<Option<PendingReload>> = Mutex::new(None);

/// What a hot reload came to: done (reloaded, or why not), or waiting for
/// the user's choice ([`decide_hot_reload`]).
enum Outcome {
    Done(Result<(), String>),
    Waiting,
}

fn finish_hot_reload(app: &AppHandle, mod_id: &str, outcome: Outcome) {
    let (ok, message) = match outcome {
        Outcome::Waiting => return,
        Outcome::Done(Ok(())) => (true, format!("{mod_id} reloaded")),
        Outcome::Done(Err(e)) => (false, e),
    };
    HOT_RELOAD_BUSY.store(false, Ordering::SeqCst);
    emit_hot_reload(app, "done", mod_id, Some(ok), message);
}

/// The user's answer to a hot reload that needs a restart for part of it:
/// `"apply"` reloads what can be (code, resources, data) anyway; anything
/// else drops it (`"restart"`: the IDE restarts the game itself).
pub fn decide_hot_reload(app: AppHandle, choice: String) -> Result<(), String> {
    let pending = PENDING_RELOAD.lock().unwrap().take().ok_or("no hot reload is waiting")?;
    std::thread::spawn(move || {
        let outcome = if choice == "apply" {
            Outcome::Done(apply_reload(&app, &pending.mod_id, pending.session_id, &pending.yog_path))
        } else {
            Outcome::Done(Err(format!("{} not reloaded ({choice})", pending.mod_id)))
        };
        finish_hot_reload(&app, &pending.mod_id, outcome);
    });
    Ok(())
}

/// Sends `request` over the session's control socket and waits for the
/// runtime's `event` answer.
fn ask_control(app: &AppHandle, session_id: u64, request: &serde_json::Value, event: &'static str) -> Result<serde_json::Value, String> {
    let (tx, rx) = mpsc::channel();
    {
        let debug_state = app.state::<DebugState>();
        let mut guard = debug_state.0.lock().unwrap();
        let session = guard.as_mut().filter(|s| s.id == session_id).ok_or("the game exited")?;
        let control = session.control.as_mut().ok_or("control socket is gone")?;
        send_control(control, request).map_err(|e| format!("writing to the control socket: {e}"))?;
        session.reply_waiter = Some((event, tx));
    }
    match rx.recv_timeout(HOT_RELOAD_TIMEOUT) {
        Ok(v) => Ok(v),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(format!("the game didn't answer within {}s", HOT_RELOAD_TIMEOUT.as_secs())),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err("the game exited before answering".to_string()),
    }
}

fn run_hot_reload(
    app: &AppHandle,
    root: &Path,
    mod_id: &str,
    session_id: u64,
    debug_mode: bool,
) -> Outcome {
    match build_and_check(app, root, mod_id, session_id, debug_mode) {
        Err(e) => Outcome::Done(Err(e)),
        Ok((yog_path, changes)) if changes.is_empty() => Outcome::Done(apply_reload(app, mod_id, session_id, &yog_path)),
        Ok((yog_path, changes)) => {
            *PENDING_RELOAD.lock().unwrap() = Some(PendingReload { mod_id: mod_id.to_string(), session_id, yog_path });
            let n = changes.added.len() + changes.removed.len() + changes.changed.len();
            let _ = app.emit(crate::events::OUTPUT_BUILD, format!("hot reload: {n} change(s) only a restart applies"));
            let _ = app.emit(
                crate::events::HOT_RELOAD,
                HotReloadEvent {
                    stage: "confirm",
                    mod_id: mod_id.to_string(),
                    ok: None,
                    message: format!("{n} change(s) need a restart"),
                    changes: Some(changes),
                },
            );
            Outcome::Waiting
        }
    }
}

/// Builds the mod for hot reload (`yog build [debug] --dev`) and asks the
/// game what of it only a restart applies.
fn build_and_check(
    app: &AppHandle,
    root: &Path,
    mod_id: &str,
    session_id: u64,
    debug_mode: bool,
) -> Result<(PathBuf, RegistrationChanges), String> {
    let mut args = vec!["build"];
    if debug_mode {
        args.push("debug");
    }
    args.push("--dev");
    emit_hot_reload(
        app,
        "building",
        mod_id,
        None,
        format!("running `yog {}`", args.join(" ")),
    );
    let mut child = crate::cli::command()
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
                    let _ = out_app.emit(crate::events::OUTPUT_BUILD, line);
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

    let check = ask_control(
        app,
        session_id,
        &serde_json::json!({ "cmd": "hot_reload_check", "mod_id": mod_id, "yog_path": yog_path.to_string_lossy() }),
        "hot-reload-check",
    )?;
    let list = |key: &str| -> Vec<String> {
        check.get(key).and_then(|v| v.as_array()).into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).collect()
    };
    Ok((yog_path, RegistrationChanges { added: list("added"), removed: list("removed"), changed: list("changed") }))
}

/// Swaps the built `.yog` into the game: its code, then the game rereads
/// its resources and data (F3+T, `/reload`).
fn apply_reload(app: &AppHandle, mod_id: &str, session_id: u64, yog_path: &Path) -> Result<(), String> {
    emit_hot_reload(app, "reloading", mod_id, None, format!("sent {} to the game", yog_path.display()));
    let done = ask_control(
        app,
        session_id,
        &serde_json::json!({ "cmd": "hot_reload", "mod_id": mod_id, "yog_path": yog_path.to_string_lossy(), "resources": true }),
        "hot-reload-done",
    )?;
    if !done.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err(format!(
            "the game rejected the new build of {mod_id} (see the game log — most often an ABI version mismatch, \
             which needs a full restart)"
        ));
    }
    let debug_state = app.state::<DebugState>();
    let mut guard = debug_state.0.lock().unwrap();
    if let Some(session) = guard.as_mut().filter(|s| s.id == session_id) {
        #[cfg(target_os = "linux")]
        if let Some(tracer) = &session.tracer {
            tracer.send(TracerCmd::Rebind);
        }
        // A reload can change the mod's reported version — refresh the list
        // (the answer arrives as a `mods` event, see `handle_control_event`).
        if let Some(control) = session.control.as_mut() {
            let _ = send_control(control, &serde_json::json!({ "cmd": "list_mods" }));
        }
    }
    Ok(())
}

/// Clears whatever's left of the session and reports "the game is gone" —
/// called both when the control socket drops (the common, prompt path) and
/// by `spawn_exit_watcher`'s `try_wait` polling (the backstop for a run
/// whose socket never connected in the first place). Safe to call more than
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
            crate::events::GAME_STATUS,
            GameStatus {
                stage: "exited",
                pid: None,
                mods: Vec::new(),
            },
        );
        let _ = app.emit(crate::events::DEBUG_STOPPED, DebugStoppedEvent::exited());
        // `useModRunTargets`'s `running` flag only ever resets on this
        // event (a holdover from the old `run_and_stream`-based flow,
        // which fired it automatically) — without it, `RunBar`'s Start
        // button stays disabled forever after the game exits, since
        // nothing in this newer control-socket flow ever emitted it.
        let _ = app.emit(crate::events::WORKFLOW_EXIT, ());
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
    let _ = app.emit(crate::events::DEBUG_ATTACH_FAILED, message.clone());
    let _ = app.emit(crate::events::OUTPUT_DEBUG, format!("[error] {message}"));
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
        kill_pid(pid);
    }
    #[cfg(target_os = "linux")]
    drop(session.tracer.take());
    kill_tree(&mut session.wrapper);

    let _ = app.emit(
        crate::events::GAME_STATUS,
        GameStatus {
            stage: "exited",
            pid: None,
            mods: Vec::new(),
        },
    );
    let _ = app.emit(crate::events::DEBUG_STOPPED, DebugStoppedEvent::exited());
    let _ = app.emit(crate::events::WORKFLOW_EXIT, ());
    Ok(())
}

/// Kills process `pid` (the game: `yog run` doesn't own it once Gradle's
/// daemon launched it).
fn kill_pid(pid: i32) {
    #[cfg(unix)]
    let _ = substrate_platform::process::command("kill").args(["-9", &pid.to_string()]).status();
    #[cfg(windows)]
    let _ = substrate_platform::process::command("taskkill").args(["/F", "/PID", &pid.to_string()]).status();
}

/// Kills `child` and everything it launched — `yog run` starts the game as
/// its own child, which a plain `Child::kill` would leave running.
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    let _ = substrate_platform::process::command("taskkill").args(["/T", "/F", "/PID", &child.id().to_string()]).status();
    #[cfg(unix)]
    let _ = substrate_platform::process::command("pkill").args(["-P", &child.id().to_string()]).status();
    let _ = child.kill();
    let _ = child.wait();
}

/// On Yog-IDLE exiting: the game it launched keeps running (see
/// `crate::spawn_yog_run`), so a debug session detaches from it first —
/// otherwise its breakpoints would stay armed with nobody left to handle
/// the trap. Waits briefly; the game itself is never stopped here.
#[cfg(target_os = "linux")]
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

#[cfg(not(target_os = "linux"))]
pub fn detach_on_exit(_app: &AppHandle) {}

/// The debug commands where there's no native debugger yet (it's `ptrace`,
/// Linux): the same command surface, each saying so.
#[cfg(not(target_os = "linux"))]
mod no_trace {
    const UNSUPPORTED: &str = "debugging native code needs Linux so far — a Debug run still hot-reloads";

    #[tauri::command]
    pub fn debug_set_breakpoint(file: String, line: u32) -> Result<(), String> {
        let _ = (file, line);
        Ok(())
    }

    #[tauri::command]
    pub fn debug_clear_breakpoint(file: String, line: u32) -> Result<(), String> {
        let _ = (file, line);
        Ok(())
    }

    #[tauri::command]
    pub fn debug_continue() -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn debug_step(kind: Option<String>) -> Result<(), String> {
        let _ = kind;
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn debug_pause() -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn debug_select_thread(thread: i32) -> Result<(), String> {
        let _ = thread;
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn debug_variables(frame: usize) -> Result<Vec<()>, String> {
        let _ = frame;
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn debug_evaluate(frame: usize, exprs: Vec<String>) -> Result<Vec<()>, String> {
        let _ = (frame, exprs);
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn debug_children(handle: u64) -> Result<Vec<()>, String> {
        let _ = handle;
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn debug_grant_ptrace_capability() -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
}
