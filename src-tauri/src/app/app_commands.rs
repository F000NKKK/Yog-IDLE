//! The app itself: restarting it.

use crate::*;

/// Restarts Yog-IDLE — e.g. after `debug_grant_ptrace_capability`, which
/// only takes effect for a fresh `exec()`.
#[tauri::command]
pub(crate) fn app_restart(app: AppHandle) {
    app.restart();
}
