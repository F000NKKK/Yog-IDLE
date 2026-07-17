use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use substrate_platform::PtySession;
use tauri::{AppHandle, Emitter, State};

/// Every open integrated terminal, keyed by a frontend-chosen id, so the UI
/// can run several at once (VS-Code style) and address each independently.
#[derive(Default)]
struct PtyState(Mutex<HashMap<String, PtySession>>);

/// A chunk of one terminal's output — carries the id so the frontend routes it
/// to the right xterm instance.
#[derive(Clone, Serialize)]
struct PtyOutput {
    id: String,
    data: String,
}

/// Emitted once when a terminal's shell exits, so the frontend can close that tab.
#[derive(Clone, Serialize)]
struct PtyExit {
    id: String,
}

#[tauri::command]
fn pty_spawn(app: AppHandle, state: State<PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let out_app = app.clone();
    let out_id = id.clone();
    let exit_app = app.clone();
    let exit_id = id.clone();
    let session = PtySession::spawn(
        None,
        None,
        cols,
        rows,
        move |bytes| {
            let data = String::from_utf8_lossy(&bytes).into_owned();
            let _ = out_app.emit("pty-output", PtyOutput { id: out_id.clone(), data });
        },
        move || {
            let _ = exit_app.emit("pty-exit", PtyExit { id: exit_id.clone() });
        },
    )
    .map_err(|e| e.to_string())?;
    state.0.lock().unwrap().insert(id, session);
    Ok(())
}

#[tauri::command]
fn pty_write(state: State<PtyState>, id: String, data: String) -> Result<(), String> {
    if let Some(session) = state.0.lock().unwrap().get_mut(&id) {
        session.write(data.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_resize(state: State<PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    if let Some(session) = state.0.lock().unwrap().get(&id) {
        session.resize(cols, rows).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_kill(state: State<PtyState>, id: String) -> Result<(), String> {
    if let Some(mut session) = state.0.lock().unwrap().remove(&id) {
        let _ = session.kill();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![pty_spawn, pty_write, pty_resize, pty_kill])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
