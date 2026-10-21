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
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::time::Duration;
use substrate_platform::sync::Locked;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use yog_hot_reload::control::{self as protocol, Changes, Command, Event, ModInfo};

mod control;
pub use control::*;
mod hot_reload;
pub use hot_reload::*;

#[cfg(target_os = "linux")]
mod trace;
#[cfg(not(target_os = "linux"))]
pub use no_trace::*;
#[cfg(target_os = "linux")]
pub use trace::*;

/// A request waiting for the game's answer: which event answers it, and where that goes.
type ReplyWaiter = (fn(&Event) -> bool, Sender<Event>);

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
    reply_waiter: Option<ReplyWaiter>,
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

/// Clears whatever's left of the session and reports "the game is gone" —
/// called both when the control socket drops (the common, prompt path) and
/// by `spawn_exit_watcher`'s `try_wait` polling (the backstop for a run
/// whose socket never connected in the first place). Safe to call more than
/// once — a session that's already gone (or already replaced by a newer
/// one, e.g. after Restart) is simply a no-op.
fn mark_exited(app: &AppHandle, session_id: u64) {
    let had_session = {
        let debug_state = app.state::<DebugState>();
        let mut guard = debug_state.0.locked();
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
            let mut guard = debug_state.0.locked();
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
    let session = state.inner().0.locked().take();
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
    let _ = substrate_platform::process::command("kill")
        .args(["-9", &pid.to_string()])
        .status();
    #[cfg(windows)]
    let _ = substrate_platform::process::command("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .status();
}

/// Kills `child` and everything it launched — `yog run` starts the game as
/// its own child, which a plain `Child::kill` would leave running.
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    let _ = substrate_platform::process::command("taskkill")
        .args(["/T", "/F", "/PID", &child.id().to_string()])
        .status();
    #[cfg(unix)]
    let _ = substrate_platform::process::command("pkill")
        .args(["-P", &child.id().to_string()])
        .status();
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
        .locked()
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
    const UNSUPPORTED: &str =
        "debugging native code needs Linux so far — a Debug run still hot-reloads";

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
