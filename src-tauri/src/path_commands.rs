//! Paths as Yog IDLE inspects them (Properties), the workspace check its
//! commands share, and the mod's manifest fields. Folders and files
//! themselves are Substrate's (`tauri-plugin-substrate`, feature `fs`).

use super::*;

/// `Ok` when `path` is in the workspace.
pub(super) fn validate_within_roots(state: &Workspace, path: &Path) -> Result<(), String> {
    state.check(path).map_err(|m| m.to_string())
}

/// Size, timestamps, read-only flag (and, for a folder, its item count and
/// whether it's a mod project) — for the Properties window. Like
/// `file_read`, any path may be inspected; changing it is what stays
/// confined to the open project.
#[tauri::command]
pub(super) fn path_info(path: String) -> Result<properties::PathInfo, String> {
    properties::path_info(Path::new(&path))
}

#[tauri::command]
pub(super) fn path_set_readonly(state: State<Workspace>, path: String, read_only: bool) -> Result<(), String> {
    let target = PathBuf::from(&path);
    validate_within_roots(&state, &target)?;
    properties::set_read_only(&target, read_only)
}

/// A mod project's `yog.toml` `[mod]` fields, for the Properties window.
#[tauri::command]
pub(super) fn mod_manifest_read(project_root: String) -> Result<properties::ManifestOut, String> {
    properties::read_manifest(Path::new(&project_root))
}

/// Edits one `yog.toml` `[mod]` field in place (formatting preserved) —
/// resolves the manifest as it now reads.
#[tauri::command]
pub(super) fn mod_manifest_set(
    state: State<Workspace>,
    project_root: String,
    key: String,
    value: properties::FieldValue,
) -> Result<properties::ManifestOut, String> {
    let root = PathBuf::from(&project_root);
    validate_within_roots(&state, &manifest::path(&root))?;
    properties::set_manifest_field(&root, &key, value)
}
