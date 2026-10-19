//! What IDLE remembers: per project (`.idle/`) and app-wide (`state.json`);
//! restarting the app.

use super::*;

/// The project-local folder Yog-IDLE keeps its own per-project data in
/// (publish profiles, `workspace.json`) — see `ensure_gitignored`.
pub(super) fn idle_dir(project_root: &Path) -> PathBuf {
    project_root.join(manifest::IDLE_DIR)
}

pub(super) fn workspace_file(project_root: &Path) -> PathBuf {
    idle_dir(project_root).join("workspace.json")
}

/// Reads a JSON object from `path`, treating a missing, unreadable or corrupt
/// file (or one that isn't an object) as empty — remembered UI state is a
/// convenience, never a reason to fail.
pub(super) fn read_state_file(path: &Path) -> serde_json::Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str::<serde_json::Value>(&contents).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()))
}

/// Writes `value` as pretty JSON atomically — to a sibling temp file first,
/// then renamed over `path` — so a crash mid-write can never leave a
/// half-written (corrupt) state file behind.
pub(super) fn write_state_file(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// The project's remembered UI state (`.yog-idle/workspace.json` — open
/// files, layout, expanded folders, ...), like Visual Studio's `.vs`. An
/// arbitrary JSON object: the frontend owns its keys.
#[tauri::command]
pub(super) fn workspace_load(
    state: State<Workspace>,
    project_root: String,
) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    Ok(read_state_file(&workspace_file(&root)))
}

#[tauri::command]
pub(super) fn workspace_save(
    state: State<Workspace>,
    project_root: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    let dir = idle_dir(&root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Machine-local state, never meant for version control — ignored from
    // inside the folder itself, so the project's own `.gitignore` is left
    // alone.
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        std::fs::write(&ignore, "*\n").map_err(|e| e.to_string())?;
    }
    write_state_file(&workspace_file(&root), &value)
}

pub(super) fn app_state_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("state.json"))
}

/// UI state that isn't tied to any project (the recent projects list, the
/// last project opened, the layout shown with no project open) — kept in the
/// app's own config directory.
#[tauri::command]
pub(super) fn app_state_load(app: AppHandle) -> Result<serde_json::Value, String> {
    Ok(read_state_file(&app_state_file(&app)?))
}

#[tauri::command]
pub(super) fn app_state_save(app: AppHandle, value: serde_json::Value) -> Result<(), String> {
    write_state_file(&app_state_file(&app)?, &value)
}

/// Restarts Yog-IDLE — e.g. after `debug_grant_ptrace_capability`, which
/// only takes effect for a fresh `exec()`.
#[tauri::command]
pub(super) fn app_restart(app: AppHandle) {
    app.restart();
}
