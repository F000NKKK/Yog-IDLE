//! The non-Linux counterpart of `debugger.rs`: `yog run <config>` with no
//! control socket and no debugger (both are Linux-only so far), but still
//! a launch the toolbar's Stop/Restart can act on — the frontend calls the
//! same `debug_*` commands on every platform, so they all exist here too:
//! `debug_stop` really stops the run, breakpoint edits are accepted (the
//! gutter keeps working) but there is nothing to arm them in, and
//! continue/step report that native debugging isn't available.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

const UNSUPPORTED: &str = "native debugging is only supported on Linux for now";

struct PlainRun {
    /// Same purpose as `debugger::RunSession::id` — a stale exit watcher
    /// must never tear down the run that replaced its own.
    id: u64,
    child: Child,
}

#[derive(Default)]
pub struct DebugState(Mutex<Option<PlainRun>>);

static NEXT_RUN_ID: AtomicU64 = AtomicU64::new(1);

/// The subset of `debugger.rs`'s `game-status` payload this side can
/// report — no pid or mod list without the control socket.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameStatus {
    stage: &'static str,
    pid: Option<i32>,
    mods: Vec<()>,
}

fn emit_exited(app: &AppHandle) {
    let _ = app.emit(
        "game-status",
        GameStatus {
            stage: "exited",
            pid: None,
            mods: Vec::new(),
        },
    );
    let _ = app.emit("workflow-exit", ());
}

/// Spawns `yog run <config_name>` with its output streamed to Output and
/// polls it for exit — `mode` is accepted for symmetry with Linux but a
/// debug-mode run is just a plain one here.
pub fn run(app: AppHandle, project_root: String, config_name: String) -> Result<(), String> {
    let mut child = Command::new("yog")
        .args(["run", &config_name])
        .current_dir(&project_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch `yog run {config_name}`: {e}"))?;

    crate::stream_yog_run(&app, &mut child);

    let id = NEXT_RUN_ID.fetch_add(1, Ordering::Relaxed);
    *app.state::<DebugState>().0.lock().unwrap() = Some(PlainRun { id, child });
    let _ = app.emit(
        "game-status",
        GameStatus {
            stage: "starting",
            pid: None,
            mods: Vec::new(),
        },
    );

    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let debug_state = app.state::<DebugState>();
            let mut guard = debug_state.0.lock().unwrap();
            let Some(run) = guard.as_mut().filter(|r| r.id == id) else {
                return;
            };
            if !matches!(run.child.try_wait(), Ok(None)) {
                *guard = None;
                drop(guard);
                emit_exited(&app);
                return;
            }
        }
    });
    Ok(())
}

/// Kills `child` and everything it launched — `yog run` starts the game as
/// its own child, which a plain `Child::kill` would leave running.
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &child.id().to_string()])
        .status();
    #[cfg(not(windows))]
    let _ = Command::new("pkill")
        .args(["-P", &child.id().to_string()])
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

#[tauri::command]
pub fn debug_stop(app: AppHandle, state: State<DebugState>) -> Result<(), String> {
    let run = state.inner().0.lock().unwrap().take();
    if let Some(mut run) = run {
        kill_tree(&mut run.child);
        emit_exited(&app);
    }
    Ok(())
}

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
    Err(UNSUPPORTED.to_string())
}

#[tauri::command]
pub fn debug_step(kind: Option<String>) -> Result<(), String> {
    let _ = kind;
    Err(UNSUPPORTED.to_string())
}

#[tauri::command]
pub fn debug_pause() -> Result<(), String> {
    Err(UNSUPPORTED.to_string())
}

#[tauri::command]
pub fn debug_select_thread(thread: i32) -> Result<(), String> {
    let _ = thread;
    Err(UNSUPPORTED.to_string())
}

#[tauri::command]
pub fn debug_grant_ptrace_capability() -> Result<(), String> {
    Err(UNSUPPORTED.to_string())
}
