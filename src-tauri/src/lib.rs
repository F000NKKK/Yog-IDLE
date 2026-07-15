use std::sync::Mutex;

use substrate_platform::PtySession;
use tauri::{AppHandle, Emitter, State};

/// Single PTY session for now — Yog-IDLE opens one integrated terminal.
/// (Multiple concurrent sessions would just need this keyed by an id.)
#[derive(Default)]
struct PtyState(Mutex<Option<PtySession>>);

#[tauri::command]
fn pty_spawn(app: AppHandle, state: State<PtyState>, cols: u16, rows: u16) -> Result<(), String> {
    let app_handle = app.clone();
    let session = PtySession::spawn(None, None, cols, rows, move |bytes| {
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let _ = app_handle.emit("pty-output", text);
    })
    .map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(session);
    Ok(())
}

#[tauri::command]
fn pty_write(state: State<PtyState>, data: String) -> Result<(), String> {
    if let Some(session) = state.0.lock().unwrap().as_mut() {
        session.write(data.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_resize(state: State<PtyState>, cols: u16, rows: u16) -> Result<(), String> {
    if let Some(session) = state.0.lock().unwrap().as_ref() {
        session.resize(cols, rows).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![pty_spawn, pty_write, pty_resize])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
