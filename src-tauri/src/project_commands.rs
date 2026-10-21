//! The mod's manifest and Project Properties, opening and closing a project.

use super::*;

// ── Project Properties (`project_properties.rs`) ─────────────────────────────

#[tauri::command]
pub(super) fn project_properties_read(
    state: State<Workspace>,
    project_root: String,
) -> Result<project_properties::ProjectProps, String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    project_properties::read(&root)
}

/// A `[mod]` field or `authors`.
#[tauri::command]
pub(super) fn project_properties_set_field(
    state: State<Workspace>,
    project_root: String,
    key: String,
    value: properties::FieldValue,
) -> Result<project_properties::ProjectProps, String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    project_properties::set_field(&root, &key, value)
}

/// `which`: `"version"` (the `[dependencies]` pin) or `"path"` (`[dev] yog_api_path`).
#[tauri::command]
pub(super) fn project_properties_set_yog_api(
    state: State<Workspace>,
    project_root: String,
    which: String,
    value: String,
) -> Result<project_properties::ProjectProps, String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    match which.as_str() {
        "version" => project_properties::set_yog_api_version(&root, &value),
        "path" => project_properties::set_yog_api_path(&root, &value),
        other => Err(format!("unknown yog-api setting '{other}'")),
    }
}

#[tauri::command]
pub(super) fn project_dependency_set(
    state: State<Workspace>,
    project_root: String,
    mods: bool,
    original: Option<String>,
    dependency: project_properties::Dependency,
) -> Result<project_properties::ProjectProps, String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    project_properties::set_dependency(&root, mods, original.as_deref(), &dependency)
}

#[tauri::command]
pub(super) fn project_dependency_remove(
    state: State<Workspace>,
    project_root: String,
    mods: bool,
    name: String,
) -> Result<project_properties::ProjectProps, String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    project_properties::remove_dependency(&root, mods, &name)
}

#[tauri::command]
pub(super) fn project_build_targets_set(
    state: State<Workspace>,
    project_root: String,
    targets: Vec<String>,
) -> Result<project_properties::ProjectProps, String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    project_properties::set_build_targets(&root, &targets)
}

/// The Dependencies page's search — crates.io (`mods`: Yog mods' exports crates).
#[tauri::command]
pub(super) async fn crates_search(
    query: String,
    mods: bool,
) -> Result<Vec<project_properties::CrateHit>, String> {
    tauri::async_runtime::spawn_blocking(move || project_properties::search_crates(&query, mods))
        .await
        .map_err(|e| e.to_string())?
}

/// Yog-IDLE's own recognized project standards, loaded from data
/// (`standards.toml`) rather than hardcoded here — `substrate-platform`
/// ships none of these itself, only the generic `ProjectStandard`/detection
/// machinery (it already derives `Serialize`/`Deserialize` for exactly this),
/// so a fork or a different product can swap in its own detection rules
/// without touching any Rust logic.
pub(super) const BUILT_IN_STANDARDS_TOML: &str = include_str!("standards.toml");

#[derive(Deserialize)]
pub(super) struct StandardsFile {
    pub(super) standard: Vec<ProjectStandard>,
}

pub(super) fn built_in_standards() -> Vec<ProjectStandard> {
    toml::from_str::<StandardsFile>(BUILT_IN_STANDARDS_TOML)
        .map(|f| f.standard)
        .unwrap_or_default()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectOut {
    pub(super) name: String,
    pub(super) root: String,
    pub(super) kind: Option<String>,
}

/// Opens `path` (a folder) as the current project — Yog-IDLE has no
/// "solution" grouping concept (that's an optional feature of the generic
/// engine some *other* product might use; this one doesn't), just a single
/// project identified by its root folder, auto-detected against
/// `built_in_standards()` (in practice: does it have a `yog.toml`?). The
/// root becomes an allowed path boundary for `dir_*`/workflow commands.
#[tauri::command]
pub(super) fn project_open(state: State<Workspace>, path: String) -> Result<ProjectOut, String> {
    let canonical = state.open(Path::new(&path)).map_err(|m| m.to_string())?;
    let files: Vec<String> = substrate_platform::fs::dir::list_dir(&canonical)
        .map(|entries| entries.into_iter().map(|e| e.name).collect())
        .unwrap_or_default();
    let kind = ProjectStandard::detect(&files, &built_in_standards());
    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Project".to_string());

    Ok(ProjectOut {
        name,
        root: canonical.to_string_lossy().into_owned(),
        kind,
    })
}

/// File > Close Folder — nothing is shown anymore, so new terminals go back
/// to starting in the process's own directory. The root stays an allowed
/// path (a tab still open from it can be saved); it only stops being *the*
/// project.
#[tauri::command]
pub(super) fn project_close(state: State<Workspace>) {
    state.close();
}
