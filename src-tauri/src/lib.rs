use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use substrate_platform::{
    EntryKind, Level, LogLine, LogSink, ProjectStandard, PtyOptions, PtySession, ShellInfo,
    WorkflowFile, WorkflowHandle, WorkflowResult,
};
use tauri::{AppHandle, Emitter, Manager, State};

mod content;
mod designer;
mod environment;
mod events;
mod git;
mod manifest;
mod project_properties;
mod properties;
mod search;
mod symbols;
mod yui;

#[cfg(target_os = "linux")]
mod debugger;
// Same command surface (`debug_*`) as the Linux debugger, minus the
// debugger itself — see `plain_run.rs`.
#[cfg(not(target_os = "linux"))]
mod plain_run;
#[cfg(not(target_os = "linux"))]
use plain_run as debugger;

/// Every path a `dir_*`/`file_*` command may touch — and every project root a
/// workflow/`mod_*`/`publish_*` command reads from or runs a process in —
/// must resolve under one of these, populated by `project_open`. An IDE should never read/write
/// outside a project the user actually opened; this boundary is deliberately
/// enforced here rather than in `substrate-platform`, which stays
/// path-policy-agnostic.
#[derive(Default)]
struct AppState {
    project_roots: Mutex<Vec<PathBuf>>,
    /// The project currently shown (set by `project_open`, cleared by
    /// `project_close`) — new integrated terminals start in its root.
    current_project: Mutex<Option<PathBuf>>,
}

/// Walks up to the nearest existing ancestor of `path` (so this also covers
/// not-yet-created paths — a new file/folder, or a rename's destination),
/// canonicalizes it, and checks it falls under an open project root.
fn validate_within_roots(state: &State<AppState>, path: &Path) -> Result<(), String> {
    let roots = state.project_roots.lock().unwrap();
    if roots.is_empty() {
        return Err("no project is open".to_string());
    }
    let mut candidate = path.to_path_buf();
    let canonical = loop {
        if let Ok(resolved) = candidate.canonicalize() {
            break resolved;
        }
        match candidate.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => candidate = parent.to_path_buf(),
            _ => {
                return Err(format!(
                    "path '{}' does not resolve to anything on disk",
                    path.display()
                ));
            }
        }
    };
    if roots.iter().any(|root| canonical.starts_with(root)) {
        Ok(())
    } else {
        Err(format!(
            "path '{}' is outside any open project",
            path.display()
        ))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntryOut {
    name: String,
    path: String,
    kind: &'static str,
}

impl From<substrate_platform::DirEntryInfo> for DirEntryOut {
    fn from(entry: substrate_platform::DirEntryInfo) -> Self {
        DirEntryOut {
            name: entry.name,
            path: entry.path.to_string_lossy().into_owned(),
            kind: match entry.kind {
                EntryKind::Dir => "dir",
                EntryKind::File => "file",
            },
        }
    }
}

#[tauri::command]
fn dir_list(state: State<AppState>, path: String) -> Result<Vec<DirEntryOut>, String> {
    let target = PathBuf::from(&path);
    validate_within_roots(&state, &target)?;
    substrate_platform::dir::list_dir(&target)
        .map_err(|e| e.to_string())
        .map(|entries| entries.into_iter().map(DirEntryOut::from).collect())
}

#[tauri::command]
fn dir_create_file(state: State<AppState>, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    validate_within_roots(&state, &target)?;
    substrate_platform::dir::create_file(&target).map_err(|e| e.to_string())
}

#[tauri::command]
fn dir_create_dir(state: State<AppState>, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    validate_within_roots(&state, &target)?;
    substrate_platform::dir::create_dir(&target).map_err(|e| e.to_string())
}

#[tauri::command]
fn dir_rename(state: State<AppState>, from: String, to: String) -> Result<(), String> {
    let from_path = PathBuf::from(&from);
    let to_path = PathBuf::from(&to);
    validate_within_roots(&state, &from_path)?;
    validate_within_roots(&state, &to_path)?;
    substrate_platform::dir::rename(&from_path, &to_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn dir_remove(state: State<AppState>, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    validate_within_roots(&state, &target)?;
    substrate_platform::dir::remove(&target).map_err(|e| e.to_string())
}

/// Copies a file or a whole folder to `to`, which mustn't exist yet — the
/// explorer's Copy/Paste and Add Existing Item. The source may be anywhere
/// (like `file_read`); only the destination must be in an open project.
#[tauri::command]
fn dir_copy(state: State<AppState>, from: String, to: String) -> Result<(), String> {
    let from_path = PathBuf::from(&from);
    let to_path = PathBuf::from(&to);
    validate_within_roots(&state, &to_path)?;
    if to_path.exists() {
        return Err(format!("'{}' already exists", to_path.display()));
    }
    if to_path.starts_with(&from_path) {
        return Err("can't copy a folder into itself".to_string());
    }
    copy_recursive(&from_path, &to_path).map_err(|e| e.to_string())
}

fn copy_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
}

/// The watcher behind `fs_watch`, created on first use.
#[derive(Default)]
struct WatchState(std::sync::OnceLock<substrate_platform::DirWatcher>);

/// Watches exactly `folders` (the Project Explorer's listed folders, the
/// open files' folders) for changes made outside the IDE; each burst comes
/// back as one `fs-changed` with the changed paths, spelled like `folders`.
#[tauri::command]
fn fs_watch(app: AppHandle, state: State<WatchState>, folders: Vec<String>) -> Result<(), String> {
    let watcher = match state.0.get() {
        Some(w) => w,
        None => {
            let w = substrate_platform::DirWatcher::new(substrate_platform::watch::DEFAULT_QUIET, move |paths| {
                let paths: Vec<String> = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                let _ = app.emit(events::FS_CHANGED, paths);
            })
            .map_err(|e| e.to_string())?;
            let _ = state.0.set(w);
            state.0.get().expect("just set")
        }
    };
    watcher.set(folders.into_iter().map(PathBuf::from));
    Ok(())
}

#[tauri::command]
fn file_read(path: String) -> Result<String, String> {
    // Any file may be *read* — a debugger frame in `std` or a dependency,
    // a source the user opens from anywhere; `file_write` is what stays
    // confined to the open project's roots.
    let target = PathBuf::from(&path);
    if !target.is_file() {
        return Err(format!("'{}' is not a file", target.display()));
    }
    substrate_platform::dir::read_file(&target).map_err(|e| e.to_string())
}

#[tauri::command]
fn file_write(state: State<AppState>, path: String, contents: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    validate_within_roots(&state, &target)?;
    substrate_platform::dir::write_file(&target, &contents).map_err(|e| e.to_string())
}

/// Size, timestamps, read-only flag (and, for a folder, its item count and
/// whether it's a mod project) — for the Properties window. Like
/// `file_read`, any path may be inspected; changing it is what stays
/// confined to the open project.
#[tauri::command]
fn path_info(path: String) -> Result<properties::PathInfo, String> {
    properties::path_info(Path::new(&path))
}

#[tauri::command]
fn path_set_readonly(state: State<AppState>, path: String, read_only: bool) -> Result<(), String> {
    let target = PathBuf::from(&path);
    validate_within_roots(&state, &target)?;
    properties::set_read_only(&target, read_only)
}

/// A mod project's `yog.toml` `[mod]` fields, for the Properties window.
#[tauri::command]
fn mod_manifest_read(project_root: String) -> Result<properties::ManifestOut, String> {
    properties::read_manifest(Path::new(&project_root))
}

/// Edits one `yog.toml` `[mod]` field in place (formatting preserved) —
/// resolves the manifest as it now reads.
#[tauri::command]
fn mod_manifest_set(
    state: State<AppState>,
    project_root: String,
    key: String,
    value: properties::FieldValue,
) -> Result<properties::ManifestOut, String> {
    let root = PathBuf::from(&project_root);
    validate_within_roots(&state, &manifest::path(&root))?;
    properties::set_manifest_field(&root, &key, value)
}

// ── Project Properties (`project_properties.rs`) ─────────────────────────────

#[tauri::command]
fn project_properties_read(
    state: State<AppState>,
    project_root: String,
) -> Result<project_properties::ProjectProps, String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    project_properties::read(&root)
}

/// A `[mod]` field or `authors`.
#[tauri::command]
fn project_properties_set_field(
    state: State<AppState>,
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
fn project_properties_set_yog_api(
    state: State<AppState>,
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
fn project_dependency_set(
    state: State<AppState>,
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
fn project_dependency_remove(
    state: State<AppState>,
    project_root: String,
    mods: bool,
    name: String,
) -> Result<project_properties::ProjectProps, String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    project_properties::remove_dependency(&root, mods, &name)
}

#[tauri::command]
fn project_run_target_set(
    state: State<AppState>,
    project_root: String,
    original: Option<String>,
    target: project_properties::RunTarget,
) -> Result<project_properties::ProjectProps, String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    project_properties::set_run_target(&root, original.as_deref(), &target)
}

#[tauri::command]
fn project_run_target_remove(
    state: State<AppState>,
    project_root: String,
    id: String,
) -> Result<project_properties::ProjectProps, String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    project_properties::remove_run_target(&root, &id)
}

#[tauri::command]
fn project_build_targets_set(
    state: State<AppState>,
    project_root: String,
    targets: Vec<String>,
) -> Result<project_properties::ProjectProps, String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    project_properties::set_build_targets(&root, &targets)
}

/// The Dependencies page's search — crates.io (`mods`: Yog mods' exports crates).
#[tauri::command]
async fn crates_search(
    query: String,
    mods: bool,
) -> Result<Vec<project_properties::CrateHit>, String> {
    tauri::async_runtime::spawn_blocking(move || project_properties::search_crates(&query, mods))
        .await
        .map_err(|e| e.to_string())?
}

/// Expands the allowed-path boundary to cover `path` — used by "Open File...",
/// where the user explicitly picked a file via a native OS dialog outside any
/// currently open project. That deliberate picker interaction is itself the
/// trust signal (same principle `project_open` already relies on for
/// whatever folder it's pointed at), unlike a path a script merely asked for
/// on its own.
#[tauri::command]
fn allow_path(state: State<AppState>, path: String) -> Result<(), String> {
    let canonical = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let mut roots = state.project_roots.lock().unwrap();
    if !roots.iter().any(|root| canonical.starts_with(root)) {
        roots.push(canonical);
    }
    Ok(())
}

/// Yog-IDLE's own recognized project standards, loaded from data
/// (`standards.toml`) rather than hardcoded here — `substrate-platform`
/// ships none of these itself, only the generic `ProjectStandard`/detection
/// machinery (it already derives `Serialize`/`Deserialize` for exactly this),
/// so a fork or a different product can swap in its own detection rules
/// without touching any Rust logic.
const BUILT_IN_STANDARDS_TOML: &str = include_str!("standards.toml");

#[derive(Deserialize)]
struct StandardsFile {
    standard: Vec<ProjectStandard>,
}

fn built_in_standards() -> Vec<ProjectStandard> {
    toml::from_str::<StandardsFile>(BUILT_IN_STANDARDS_TOML)
        .map(|f| f.standard)
        .unwrap_or_default()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectOut {
    name: String,
    root: String,
    kind: Option<String>,
}

/// Opens `path` (a folder) as the current project — Yog-IDLE has no
/// "solution" grouping concept (that's an optional feature of the generic
/// engine some *other* product might use; this one doesn't), just a single
/// project identified by its root folder, auto-detected against
/// `built_in_standards()` (in practice: does it have a `yog.toml`?). The
/// root becomes an allowed path boundary for `dir_*`/workflow commands.
#[tauri::command]
fn project_open(state: State<AppState>, path: String) -> Result<ProjectOut, String> {
    let requested = PathBuf::from(&path);
    let canonical = requested.canonicalize().map_err(|e| e.to_string())?;
    let kind = ProjectStandard::detect(&canonical, &built_in_standards());
    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Project".to_string());

    {
        let mut roots = state.project_roots.lock().unwrap();
        if !roots.contains(&canonical) {
            roots.push(canonical.clone());
        }
    }
    *state.current_project.lock().unwrap() = Some(canonical.clone());

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
fn project_close(state: State<AppState>) {
    *state.current_project.lock().unwrap() = None;
}

/// The project-local folder Yog-IDLE keeps its own per-project data in
/// (publish profiles, `workspace.json`) — see `ensure_gitignored`.
fn idle_dir(project_root: &Path) -> PathBuf {
    project_root.join(manifest::IDLE_DIR)
}

fn workspace_file(project_root: &Path) -> PathBuf {
    idle_dir(project_root).join("workspace.json")
}

/// Reads a JSON object from `path`, treating a missing, unreadable or corrupt
/// file (or one that isn't an object) as empty — remembered UI state is a
/// convenience, never a reason to fail.
fn read_state_file(path: &Path) -> serde_json::Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str::<serde_json::Value>(&contents).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()))
}

/// Writes `value` as pretty JSON atomically — to a sibling temp file first,
/// then renamed over `path` — so a crash mid-write can never leave a
/// half-written (corrupt) state file behind.
fn write_state_file(path: &Path, value: &serde_json::Value) -> Result<(), String> {
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
fn workspace_load(
    state: State<AppState>,
    project_root: String,
) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    Ok(read_state_file(&workspace_file(&root)))
}

#[tauri::command]
fn workspace_save(
    state: State<AppState>,
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

fn app_state_file(app: &AppHandle) -> Result<PathBuf, String> {
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
fn app_state_load(app: AppHandle) -> Result<serde_json::Value, String> {
    Ok(read_state_file(&app_state_file(&app)?))
}

#[tauri::command]
fn app_state_save(app: AppHandle, value: serde_json::Value) -> Result<(), String> {
    write_state_file(&app_state_file(&app)?, &value)
}

/// The external formatter for a file kind, by extension: the program and its
/// arguments for reading the document on stdin and writing the formatted
/// result to stdout.
fn formatter_for(path: &Path) -> Option<(&'static str, Vec<String>)> {
    let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect();
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "rs" => Some((
            "rustfmt",
            args(&["--edition", &rust_edition(path), "--emit", "stdout"]),
        )),
        "toml" => Some(("taplo", args(&["fmt", "-"]))),
        _ => None,
    }
}

/// The Rust edition `file` is written in — rustfmt can't tell from stdin:
/// its mod's `[mod] edition` (yog-cli's default 2021), else its crate's
/// `[package] edition`.
fn rust_edition(file: &Path) -> String {
    const DEFAULT: &str = "2021";
    for dir in file.ancestors().skip(1) {
        if manifest::path(dir).is_file() {
            return manifest::read_mod_field(dir, "edition").unwrap_or_else(|| DEFAULT.into());
        }
        if let Ok(text) = std::fs::read_to_string(dir.join("Cargo.toml")) {
            let edition = text
                .parse::<toml::Table>()
                .ok()
                .and_then(|doc| Some(doc.get("package")?.get("edition")?.as_str()?.to_string()));
            return edition.unwrap_or_else(|| DEFAULT.into());
        }
    }
    DEFAULT.into()
}

/// Whether Format Document can work for `path` — a formatter exists for its
/// kind and is actually installed (it answers `--version`).
#[tauri::command]
async fn format_supported(path: String) -> bool {
    let Some((program, _)) = formatter_for(Path::new(&path)) else {
        return false;
    };
    tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new(program)
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    })
    .await
    .unwrap_or(false)
}

/// Regenerates a saved `.yui` screen's generated `.g.rs` (see `yui.rs`).
#[tauri::command]
async fn yui_codegen(state: State<'_, AppState>, path: String) -> Result<yui::Codegen, String> {
    validate_within_roots(&state, Path::new(&path))?;
    tauri::async_runtime::spawn_blocking(move || yui::codegen(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// A texture as a content file names it, as a data URL.
#[tauri::command]
async fn content_texture(
    state: State<'_, AppState>,
    path: String,
    texture: String,
) -> Result<content::Texture, String> {
    validate_within_roots(&state, Path::new(&path))?;
    tauri::async_runtime::spawn_blocking(move || content::texture(Path::new(&path), &texture))
        .await
        .map_err(|e| e.to_string())?
}

/// Writes a painted texture of a content file's mod (`png`: base64 PNG
/// bytes) to where the file names it (see `content::texture_target`) —
/// never outside the mod or the open project. Returns the written path.
#[tauri::command]
async fn content_save_texture(
    state: State<'_, AppState>,
    path: String,
    texture: String,
    png: String,
) -> Result<String, String> {
    validate_within_roots(&state, Path::new(&path))?;
    let target = content::texture_target(Path::new(&path), &texture)
        .ok_or_else(|| format!("{texture} isn't a texture of this mod"))?;
    validate_within_roots(&state, &target)?;
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png.as_bytes())
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        content::write_png(&target, &bytes).map(|()| target.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The texture picker's choices for a content file.
#[tauri::command]
async fn content_textures(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<content::TextureChoice>, String> {
    validate_within_roots(&state, Path::new(&path))?;
    tauri::async_runtime::spawn_blocking(move || content::textures(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())
}

/// The name/tooltip picker's choices for a content file.
#[tauri::command]
async fn content_strings(state: State<'_, AppState>, path: String) -> Result<Vec<String>, String> {
    validate_within_roots(&state, Path::new(&path))?;
    tauri::async_runtime::spawn_blocking(move || content::strings(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())
}

/// A model by id with its parents flattened, for previewing a raw parent.
#[tauri::command]
async fn content_parent_model(
    state: State<'_, AppState>,
    path: String,
    id: String,
) -> Result<serde_json::Value, String> {
    validate_within_roots(&state, Path::new(&path))?;
    tauri::async_runtime::spawn_blocking(move || content::parent_model(Path::new(&path), &id))
        .await
        .map_err(|e| e.to_string())?
}

/// `yog import resourcepack|bbmodel` into the mod of `path`.
#[tauri::command]
async fn content_import(
    state: State<'_, AppState>,
    path: String,
    kind: String,
    source: String,
    model: Option<String>,
    force: bool,
) -> Result<String, String> {
    validate_within_roots(&state, Path::new(&path))?;
    tauri::async_runtime::spawn_blocking(move || {
        content::import(Path::new(&path), &kind, &source, model.as_deref(), force)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Draws a `.yui` screen the way the game does (see `designer/`): yog-ui's
/// layout and render with Minecraft's font and textures; plus every
/// element's rect for the designer's overlay.
#[tauri::command]
async fn yui_designer_render(args: designer::RenderArgs) -> Result<designer::Rendered, String> {
    tauri::async_runtime::spawn_blocking(move || designer::render(&args))
        .await
        .map_err(|e| e.to_string())?
}

/// One UI event in the designer's preview (see `designer::event`).
#[tauri::command]
async fn yui_designer_event(args: designer::EventArgs) -> Result<designer::EventResult, String> {
    tauri::async_runtime::spawn_blocking(move || designer::event(&args))
        .await
        .map_err(|e| e.to_string())
}

/// What the `<Image source>` picker offers for a `.yui`: the mod's textures,
/// Yog's sprite names, the game's items and blocks (see `designer::images`).
#[tauri::command]
async fn yui_image_sources(path: String) -> Result<Vec<designer::images::Candidate>, String> {
    tauri::async_runtime::spawn_blocking(move || designer::images::candidates(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())
}

/// A Yog image source drawn `size` px square, as a PNG data URL.
#[tauri::command]
async fn yui_image_preview(
    path: String,
    source: String,
    size: u32,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        designer::images::preview(Path::new(&path), &source, size)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Draws a `.ybook` the way the game does (yog-book's own renderer),
/// after what the reader did (see `designer::book`).
#[tauri::command]
async fn book_designer_render(args: designer::book::BookArgs) -> designer::book::BookRendered {
    tauri::async_runtime::spawn_blocking(move || designer::book::render(&args))
        .await
        .unwrap_or_else(|e| designer::book::BookRendered { image: None, scale: 1, shown: None, action: None, animated: false, locales: Vec::new(), error: Some(e.to_string()) })
}

/// Forgets a closed `.ybook`'s reader.
#[tauri::command]
fn book_designer_close(path: String) {
    designer::book::close(&path);
}

/// Leaves the preview: scroll positions back to the top.
#[tauri::command]
fn yui_designer_reset(path: String) {
    designer::reset(&path);
}

/// Double-click on a button: its `on_click` handler in the screen's
/// code-behind `.rs`, added if missing; where to put the caret.
#[tauri::command]
async fn yui_event_handler(
    state: State<'_, AppState>,
    path: String,
    event: String,
) -> Result<designer::codebehind::HandlerLocation, String> {
    let yui = PathBuf::from(&path);
    validate_within_roots(&state, &designer::codebehind::code_behind_path(&yui))?;
    tauri::async_runtime::spawn_blocking(move || designer::codebehind::ensure_handler(&yui, &event))
        .await
        .map_err(|e| e.to_string())?
}

/// Format Document: pipes `contents` (the editor's text — not necessarily
/// what's saved on disk) through the formatter for `path`'s kind and returns
/// the result. Runs in the file's own folder so the formatter picks up a
/// `rustfmt.toml`/`taplo.toml` there. A syntax error comes back as `Err`
/// with the formatter's own message.
#[tauri::command]
async fn format_document(path: String, contents: String) -> Result<String, String> {
    let target = PathBuf::from(&path);
    let (program, args) =
        formatter_for(&target).ok_or_else(|| format!("no formatter for '{path}'"))?;
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = target.parent().filter(|d| d.is_dir()) {
            command.current_dir(dir);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("failed to run {program}: {e}"))?;
        // Written from its own thread: a large document can fill the stdout
        // pipe before stdin is fully consumed, which would deadlock a
        // write-then-read on one thread.
        let mut stdin = child.stdin.take().expect("stdin is piped");
        let writer = std::thread::spawn(move || stdin.write_all(contents.as_bytes()));
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        let _ = writer.join();
        if output.status.success() {
            String::from_utf8(output.stdout).map_err(|e| e.to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if stderr.is_empty() {
                format!("{program} exited with {}", output.status)
            } else {
                stderr
            })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A generic escape hatch open to any project (regardless of `kind`): if it
/// happens to define its own `workflow.toml`, its named entries can be run —
/// no built-in default ships anymore now that Yog-Mod-Loader isn't a project
/// standard here.
fn resolve_workflow_file(project_root: &Path) -> Result<WorkflowFile, String> {
    let project_workflow = project_root.join("workflow.toml");
    if !project_workflow.exists() {
        return Err("this project has no workflow.toml".to_string());
    }
    let contents = std::fs::read_to_string(&project_workflow).map_err(|e| e.to_string())?;
    WorkflowFile::parse(&contents).map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowSummary {
    name: String,
    description: Option<String>,
}

#[tauri::command]
fn workflow_list(
    state: State<AppState>,
    project_root: String,
) -> Result<Vec<WorkflowSummary>, String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    let file = resolve_workflow_file(&root)?;
    let mut list: Vec<WorkflowSummary> = file
        .workflow
        .into_iter()
        .map(|(name, def)| WorkflowSummary {
            name,
            description: def.description,
        })
        .collect();
    list.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(list)
}

/// Starts `cmd` (a `yog run`) so it outlives Yog-IDLE: in its own process
/// group (a Ctrl+C or hang-up aimed at the IDE's group doesn't reach it),
/// and writing to a log file rather than pipes — when the IDE exits, a pipe
/// breaks and Gradle tears `runClient` down with it, taking the game along.
/// [`stream_yog_run`] tails that file into Output.
pub(crate) fn spawn_yog_run(
    cmd: &mut std::process::Command,
) -> std::io::Result<(std::process::Child, PathBuf)> {
    static NEXT_LOG: AtomicU64 = AtomicU64::new(1);
    let log = std::env::temp_dir().join(format!(
        "yog-idle-run-{}-{}.log",
        std::process::id(),
        NEXT_LOG.fetch_add(1, Ordering::Relaxed)
    ));
    let out = std::fs::File::create(&log)?;
    let err = out.try_clone()?;
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(cmd, 0);
    let child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(out)
        .stderr(err)
        .spawn()?;
    Ok((child, log))
}

/// Held by a run's session; dropping it (the session ending) lets
/// [`stream_yog_run`]'s tail finish reading the log and stop.
pub(crate) struct OutputTail(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl Drop for OutputTail {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// Tails a `yog run`'s log (see [`spawn_yog_run`]) into Output: everything
/// up to its `==> launched pid N` line is the mod's build (Build),
/// everything after is the game itself (Game). Lines are tagged as stderr
/// lines would be — both streams share the file, and only diagnostics get
/// a level. The log is removed once the run is over and fully read.
pub(crate) fn stream_yog_run(app: &AppHandle, log: PathBuf) -> OutputTail {
    use std::io::{BufRead, BufReader};
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    let done = Arc::new(AtomicBool::new(false));
    let tail_done = done.clone();
    let app = app.clone();
    std::thread::spawn(move || {
        let Ok(file) = std::fs::File::open(&log) else {
            return;
        };
        let mut reader = BufReader::new(file);
        let mut launched = false;
        let mut line = String::new();
        loop {
            // Checked before reading, so the final read after the run ends
            // still drains whatever it wrote last.
            let finished = tail_done.load(Ordering::SeqCst);
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) if finished => break,
                Ok(0) | Err(_) => {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    continue;
                }
                // A line still being written — wait for its end.
                Ok(_) if !line.ends_with('\n') && !finished => continue,
                Ok(_) => {}
            }
            let text = line.trim_end_matches(['\n', '\r']).to_string();
            line.clear();
            let event = if launched {
                events::OUTPUT_GAME
            } else {
                launched = text.starts_with("==> launched pid ");
                events::OUTPUT_BUILD
            };
            let _ = app.emit(event, format_stderr_line(text));
        }
        // A last line the run never finished.
        if !line.is_empty() {
            let event = if launched {
                events::OUTPUT_GAME
            } else {
                events::OUTPUT_BUILD
            };
            let _ = app.emit(event, format_stderr_line(line.trim_end().to_string()));
        }
        let _ = std::fs::remove_file(&log);
    });
    OutputTail(done)
}

/// A line a launched process wrote to stderr, labelled the way
/// `format_log_line` labels workflow output (cargo/gradle progress on
/// stderr stays unlabelled).
pub(crate) fn format_stderr_line(text: String) -> String {
    format_log_line(&LogLine {
        level: Level::of_stderr_line(&text),
        text,
    })
}

fn format_log_line(line: &LogLine) -> String {
    match line.level {
        Level::Info => line.text.clone(),
        Level::Warn => format!("[warn] {}", line.text),
        Level::Error => format!("[error] {}", line.text),
    }
}

/// Every workflow run still in flight, keyed by a per-run id — so
/// `workflow_cancel` can stop a build/publish, and each run removes only its
/// own entry when it finishes.
#[derive(Default)]
struct WorkflowState {
    next_id: AtomicU64,
    running: Mutex<HashMap<u64, WorkflowHandle>>,
}

/// Payload of `workflow-start` — the project the run builds (the Error List
/// resolves the build's relative paths against it).
#[derive(Clone, Serialize)]
struct WorkflowStart {
    root: String,
}

impl WorkflowStart {
    fn of(root: &Path) -> Self {
        Self {
            root: root.to_string_lossy().into_owned(),
        }
    }
}

/// Payload of `workflow-exit` for a workflow run — how it ended.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowExit {
    success: bool,
    cancelled: bool,
}

/// Shared "run this workflow's named entry, stream its output live, fire
/// `workflow-start` now and `workflow-exit` (with a `WorkflowExit`) when
/// done" body — `workflow_run`, `mod_build`, and
/// `publish_run` all funnel through this instead of each re-wiring the
/// sink/event plumbing themselves.
fn run_and_stream(
    app: AppHandle,
    file: WorkflowFile,
    name: String,
    vars: HashMap<String, String>,
    root: PathBuf,
) {
    let sink = LogSink::new();
    let out_app = app.clone();
    sink.on_push(move |line| {
        let _ = out_app.emit(crate::events::OUTPUT_BUILD, format_log_line(line));
    });

    // Before the run starts, so none of its output precedes it.
    let _ = app.emit(crate::events::WORKFLOW_START, WorkflowStart::of(&root));
    let handle = substrate_platform::run_workflow(file, name, vars, root, sink);
    let state = app.state::<WorkflowState>();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.running.lock().unwrap().insert(id, handle.clone());
    std::thread::spawn(move || {
        let result = handle.wait();
        app.state::<WorkflowState>()
            .running
            .lock()
            .unwrap()
            .remove(&id);
        let _ = app.emit(
            crate::events::WORKFLOW_EXIT,
            WorkflowExit {
                success: result.is_success(),
                cancelled: result == WorkflowResult::Cancelled,
            },
        );
    });
}

/// Stops every workflow run still in flight (a Build or Publish) — kills
/// the running step and skips the rest; each run then fires its own
/// `workflow-exit` with `cancelled: true`. A no-op when nothing is running.
#[tauri::command]
fn workflow_cancel(state: State<WorkflowState>) {
    for handle in state.running.lock().unwrap().values() {
        handle.cancel();
    }
}

/// Runs `name` in the background (non-blocking) — output streams live via
/// the `workflow-output` event (one plain-string line each, same contract
/// `OutputPanel` already listens for) and a `workflow-exit` event fires once
/// every step has finished, mirroring the existing `pty-output`/`pty-exit`
/// pattern.
#[tauri::command]
fn workflow_run(
    app: AppHandle,
    state: State<AppState>,
    project_root: String,
    name: String,
    vars: HashMap<String, String>,
) -> Result<(), String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    let file = resolve_workflow_file(&root)?;
    run_and_stream(app, file, name, vars, root);
    Ok(())
}

/// Builds a one-step `WorkflowFile` at runtime (a single named entry called
/// "run") — for commands (`yog run <name>`, `yog build`, `yog publish
/// exports`) that don't need a whole `workflow.toml` of their own, just the
/// engine's existing process-streaming plumbing.
fn single_step_workflow(
    program: &str,
    args: Vec<String>,
    env: HashMap<String, String>,
) -> WorkflowFile {
    let mut workflow = HashMap::new();
    workflow.insert(
        "run".to_string(),
        substrate_platform::WorkflowDef {
            description: None,
            steps: vec![substrate_platform::WorkflowStep::Run {
                run: program.to_string(),
                args,
                cwd: None,
                env,
            }],
        },
    );
    WorkflowFile { workflow }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModRunTarget {
    name: String,
    display_name: Option<String>,
    description: Option<String>,
}

/// Reads `yog.toml`'s `[run.<name>]` sections — plain named script-invocation
/// configs (like VS Code's `tasks.json`), not loader/Minecraft-version
/// settings. `yog run <name>` (yog-cli's own command) does the actual
/// build+export+launch; this only lists what's available.
// Deliberately NOT the `toml` crate here: `[run.forge-1.21.1]` is not valid
// nested-table TOML in the strict sense (a spec-compliant parser splits on
// every dot, turning "forge-1.21.1" into three levels of nested tables) —
// but `yog-cli`'s own hand-rolled parser treats everything after "run." as
// one literal name, and that's the name `yog run <name>` actually expects.
// Parsing this the strict way would silently disagree with what yog-cli
// itself does with the same file.
fn parse_mod_run_targets(contents: &str) -> Vec<ModRunTarget> {
    /// `[run.<name>]` while it's being read: name, `name =`, `command =`, `args =`.
    type PendingTarget = (String, Option<String>, Option<String>, Vec<String>);

    let mut targets: Vec<ModRunTarget> = Vec::new();
    let mut current: Option<PendingTarget> = None;

    fn flush(current: Option<PendingTarget>, targets: &mut Vec<ModRunTarget>) {
        if let Some((name, display_name, command, args)) = current {
            let description = command.map(|c| {
                if args.is_empty() {
                    c
                } else {
                    format!("{c} {}", args.join(" "))
                }
            });
            targets.push(ModRunTarget {
                name,
                display_name,
                description,
            });
        }
    }

    for raw in contents.lines() {
        let line = raw.trim();
        if line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            flush(current.take(), &mut targets);
            let section = &line[1..line.len() - 1];
            current = section
                .strip_prefix("run.")
                .map(|name| (name.to_string(), None, None, Vec::new()));
            continue;
        }
        let Some((_, display_name, command, args)) = current.as_mut() else {
            continue;
        };
        let Some((key, raw)) = line.split_once('=') else {
            continue;
        };
        let Some(value) = manifest::line_value(raw) else {
            continue;
        };
        let text = |v: &toml::Value| v.as_str().map(str::to_string);
        match key.trim() {
            "name" => *display_name = text(&value),
            "command" => *command = text(&value),
            "args" => {
                *args = value
                    .as_array()
                    .map(|a| a.iter().filter_map(text).collect())
                    .unwrap_or_default()
            }
            _ => {}
        }
    }
    flush(current, &mut targets);

    targets.sort_by(|a, b| a.name.cmp(&b.name));
    targets
}

#[tauri::command]
fn mod_run_targets(
    state: State<AppState>,
    project_root: String,
) -> Result<Vec<ModRunTarget>, String> {
    validate_within_roots(&state, Path::new(&project_root))?;
    let path = manifest::path(Path::new(&project_root));
    let contents = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(parse_mod_run_targets(&contents))
}

/// Runs a `[run.<name>]` target via `yog run <name>` — `mode` is
/// Yog-IDLE's own vocabulary (`"release"` | `"debug"`), opaque to
/// `RunBar`/the generic run-target machinery. On Linux this always
/// connects `yog-runtime`'s control socket for live status, and — for
/// `mode == "debug"` — attaches `yog-debugger` the moment it reports the
/// real pid (see `debugger::run_with_mode`). Other platforms get a plain,
/// still stoppable run (`plain_run::run`) — the control socket and the
/// debugger stack (`ptrace`) are Linux-only so far.
#[tauri::command]
fn mod_run(
    app: AppHandle,
    state: State<AppState>,
    project_root: String,
    name: String,
    mode: String,
) -> Result<(), String> {
    validate_within_roots(&state, Path::new(&project_root))?;
    #[cfg(target_os = "linux")]
    {
        debugger::run_with_mode(app, project_root, name, mode)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = mode;
        plain_run::run(app, project_root, name)
    }
}

/// Whether the Debug run mode (and everything behind it) is available on
/// this platform — the frontend hides it when it isn't.
#[tauri::command]
fn debug_supported() -> bool {
    cfg!(target_os = "linux")
}

/// The toolbar's Hot Reload: rebuilds the project and swaps the new build
/// into the running game over `yog-runtime`'s control socket — see
/// `debugger::hot_reload`. That socket is only wired up on Linux so far.
#[tauri::command]
fn mod_hot_reload(
    app: AppHandle,
    state: State<AppState>,
    project_root: String,
) -> Result<(), String> {
    validate_within_roots(&state, Path::new(&project_root))?;
    #[cfg(target_os = "linux")]
    {
        debugger::hot_reload(app, project_root)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, project_root);
        Err("hot reload is only supported on Linux for now".to_string())
    }
}

/// A one-step `yog <args>` workflow run the way Tools > Options >
/// Environment says: the configured `yog`, its tool dirs on `PATH`, and the
/// project's build platforms (`YOG_TARGETS`).
fn yog_workflow(app: &AppHandle, root: &Path, args: Vec<String>) -> WorkflowFile {
    let settings = app.state::<environment::EnvironmentState>().settings();
    let env = environment::tool_env(&settings, &project_properties::read_build_targets(root));
    single_step_workflow(&environment::yog_program(&settings), args, env)
}

/// The Build menu's plain "Build" action for a `yog-mod` project — `yog build`.
#[tauri::command]
fn mod_build(app: AppHandle, state: State<AppState>, project_root: String) -> Result<(), String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    let file = yog_workflow(&app, &root, vec!["build".to_string()]);
    run_and_stream(app, file, "run".to_string(), HashMap::new(), root);
    Ok(())
}

/// Build > Clean for a `yog-mod` project. `yog-cli` has no clean command of
/// its own, so this removes what its builds produce: cargo's `target/`, the
/// generated `.yog-build/` crate, and the packaged `artifacts/`. Reports
/// through the same `workflow-output`/`workflow-start`/`workflow-exit`
/// events as a Build.
#[tauri::command]
async fn mod_clean(
    app: AppHandle,
    state: State<'_, AppState>,
    project_root: String,
) -> Result<(), String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    let _ = app.emit(crate::events::WORKFLOW_START, WorkflowStart::of(&root));
    let out_app = app.clone();
    let success = tauri::async_runtime::spawn_blocking(move || {
        let mut success = true;
        for dir in ["target", manifest::BUILD_DIR, "artifacts"] {
            let path = root.join(dir);
            if !path.exists() {
                continue;
            }
            let line = match std::fs::remove_dir_all(&path) {
                Ok(()) => format!("removed {}", path.display()),
                Err(err) => {
                    success = false;
                    format!("[error] failed to remove {}: {err}", path.display())
                }
            };
            let _ = out_app.emit(crate::events::OUTPUT_BUILD, line);
        }
        success
    })
    .await
    .unwrap_or(false);
    let _ = app.emit(
        crate::events::WORKFLOW_EXIT,
        WorkflowExit {
            success,
            cancelled: false,
        },
    );
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishProfile {
    id: String,
    name: String,
    /// "package" — `yog build` (produces `artifacts/<id>.yog`); "exports" — `yog publish exports`.
    mode: String,
    /// Only meaningful for `mode: "exports"`.
    dry_run: bool,
}

fn publish_profiles_dir(project_root: &Path) -> PathBuf {
    idle_dir(project_root).join("publish-profiles")
}

/// Adds `.yog-idle/` to the project's `.gitignore` the first time a profile
/// is saved — publish profiles are local developer configuration (the same
/// reason people gitignore Visual Studio's own PublishProfiles), not
/// something that belongs in version control by default.
fn ensure_gitignored(project_root: &Path) {
    let gitignore_path = project_root.join(".gitignore");
    let entry = format!("{}/", manifest::IDLE_DIR);
    let existing = std::fs::read_to_string(&gitignore_path).unwrap_or_default();
    if existing.lines().any(|line| line.trim() == entry) {
        return;
    }
    let mut updated = existing;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str(&entry);
    updated.push('\n');
    let _ = std::fs::write(&gitignore_path, updated);
}

#[tauri::command]
fn publish_profiles_list(
    state: State<AppState>,
    project_root: String,
) -> Result<Vec<PublishProfile>, String> {
    validate_within_roots(&state, Path::new(&project_root))?;
    let dir = publish_profiles_dir(&PathBuf::from(project_root));
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut profiles = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().is_some_and(|ext| ext == "json") {
            let contents = std::fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
            if let Ok(profile) = serde_json::from_str::<PublishProfile>(&contents) {
                profiles.push(profile);
            }
        }
    }
    profiles.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(profiles)
}

#[tauri::command]
fn publish_profile_save(
    state: State<AppState>,
    project_root: String,
    profile: PublishProfile,
) -> Result<(), String> {
    let root = PathBuf::from(&project_root);
    validate_within_roots(&state, &root)?;
    let dir = publish_profiles_dir(&root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", profile.id));
    // `id` is caller-supplied — a `../` in it must not escape the project.
    validate_within_roots(&state, &path)?;
    let json = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;
    ensure_gitignored(&root);
    Ok(())
}

#[tauri::command]
fn publish_profile_delete(
    state: State<AppState>,
    project_root: String,
    id: String,
) -> Result<(), String> {
    validate_within_roots(&state, Path::new(&project_root))?;
    let path = publish_profiles_dir(&PathBuf::from(project_root)).join(format!("{id}.json"));
    validate_within_roots(&state, &path)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn publish_run(
    app: AppHandle,
    state: State<AppState>,
    project_root: String,
    profile: PublishProfile,
) -> Result<(), String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    let args = match profile.mode.as_str() {
        "exports" => {
            let mut args = vec!["publish".to_string(), "exports".to_string()];
            if profile.dry_run {
                args.push("--dry-run".to_string());
            }
            args
        }
        "package" => vec!["build".to_string()],
        other => return Err(format!("unknown publish mode '{other}'")),
    };
    let file = yog_workflow(&app, &root, args);
    run_and_stream(app, file, "run".to_string(), HashMap::new(), root);
    Ok(())
}

/// Every shell available to spawn, for the frontend's "new terminal" menu —
/// `ShellInfo` already serializes camelCase, ready for the frontend as-is.
#[tauri::command]
fn list_shells() -> Vec<ShellInfo> {
    substrate_platform::detect_shells()
}

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
#[allow(clippy::too_many_arguments)] // a Tauri command's arguments are its JS parameters
fn pty_spawn(
    app: AppHandle,
    state: State<PtyState>,
    app_state: State<AppState>,
    id: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    // "Open in Terminal" on a folder of the project; otherwise its root.
    let cwd = match cwd {
        Some(dir) => {
            let dir = PathBuf::from(dir);
            validate_within_roots(&app_state, &dir)?;
            Some(dir)
        }
        None => app_state.current_project.lock().unwrap().clone(),
    };
    let out_app = app.clone();
    let out_id = id.clone();
    let exit_app = app.clone();
    let exit_id = id.clone();
    // `spawn_utf8` holds back a multi-byte character split across two reads
    // until it's complete, so every chunk is valid text on its own instead of
    // each half being decoded (and garbled into U+FFFD) separately.
    let session = PtySession::spawn_utf8(
        PtyOptions {
            shell,
            cwd,
            ..PtyOptions::default()
        },
        cols,
        rows,
        move |data| {
            let _ = out_app.emit(
                crate::events::PTY_OUTPUT,
                PtyOutput {
                    id: out_id.clone(),
                    data,
                },
            );
        },
        move || {
            let _ = exit_app.emit(
                crate::events::PTY_EXIT,
                PtyExit {
                    id: exit_id.clone(),
                },
            );
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

/// Restarts Yog-IDLE — e.g. after `debug_grant_ptrace_capability`, which
/// only takes effect for a fresh `exec()`.
#[tauri::command]
fn app_restart(app: AppHandle) {
    app.restart();
}

/// `yog-idle --designer-host`: the screen designer's host process for a
/// mod's custom components (see `designer::host`) instead of the IDE.
pub fn designer_host() {
    designer::host::serve();
}

/// The mod's custom `.yui` components for the designer's toolbox, and the
/// designer library's state; (re)builds it when the mod's sources changed
/// (see `designer::custom`). Polled while a screen is open, and by the
/// Toolbox for the open project. `path`: a `.yui` file or the mod's root.
#[tauri::command]
async fn yui_designer_components(path: String) -> Result<designer::custom::Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&path);
        let root = if manifest::path(path).is_file() {
            path.to_path_buf()
        } else {
            designer::mod_root(path).ok_or("not inside a mod (no src/ folder)")?
        };
        Ok(designer::custom::status(&root))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The backend's hot paths for `benches/backend.rs` — not an API.
#[doc(hidden)]
pub mod bench {
    use std::path::{Path, PathBuf};

    pub use crate::designer::{RenderArgs, render};
    pub use crate::designer::{book, images};
    pub use crate::search::OpenDocument;
    pub use crate::symbols::{extract_symbols, fuzzy_match};

    /// A Code Search index over in-memory `(absolute, relative, source)` files.
    pub struct CodeIndex(crate::symbols::RootIndex);

    impl CodeIndex {
        pub fn new(files: &[(PathBuf, String, String)]) -> Self {
            CodeIndex(crate::symbols::RootIndex::from_sources(files))
        }

        /// Code Search's answer for `query` (all kinds), as sent to the frontend.
        pub fn search(&self, query: &str, limit: usize) -> String {
            let items = self
                .0
                .search(query, crate::symbols::CodeSearchMode::All, limit);
            serde_json::to_string(&items).unwrap()
        }
    }

    /// Find in Files over open documents, every batch as sent to the frontend.
    pub fn find_in_documents(documents: &[OpenDocument], pattern: &str) -> String {
        let query = crate::search::SearchQuery {
            pattern: pattern.to_string(),
            match_case: false,
            whole_word: false,
            regex: false,
            file_mask: String::new(),
            include_generated: false,
        };
        let mut files = Vec::new();
        crate::search::run_search(
            Some("/bench"),
            crate::search::Scope::Documents,
            &query,
            documents,
            20_000,
            &|| true,
            &mut |file| files.push(file),
        )
        .unwrap();
        serde_json::to_string(&crate::search::FindBatch { files }).unwrap()
    }

    /// `git status` output parsed into Git Changes' model, as sent to the frontend.
    pub fn git_status(top: &Path, raw: &str) -> String {
        let mut status = crate::git::parse_status(raw);
        for file in status
            .staged
            .iter_mut()
            .chain(&mut status.unstaged)
            .chain(&mut status.conflicted)
        {
            file.abs_path = crate::git::absolute(top, &file.path);
        }
        serde_json::to_string(&status).unwrap()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // Before any thread exists: the Environment options go into this
    // process's own environment, for every `yog`/`cargo` it starts.
    let env_settings = environment::default_state_file(&context.config().identifier)
        .map(|file| environment::load_settings_from(&file))
        .unwrap_or_default();
    environment::apply_to_process_at_startup(&env_settings);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Window size/position/maximized, restored on launch and saved on
        // close (into the app config dir). Not visibility or decorations —
        // the window always starts shown, with Yog-IDLE's own title bar.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .manage(PtyState::default())
        .manage(WorkflowState::default())
        .manage(AppState::default())
        .manage(WatchState::default())
        .manage(environment::EnvironmentState::with_settings(env_settings))
        .manage(search::SearchState::default())
        .manage(symbols::SymbolIndexState::default());

    let builder = builder.manage(debugger::DebugState::default());

    let builder = builder.invoke_handler(tauri::generate_handler![
        fs_watch,
        yui_codegen,
        content_texture,
        content_textures,
        content_save_texture,
        content_strings,
        content_parent_model,
        content_import,
        yui_designer_render,
        book_designer_render,
        book_designer_close,
        yui_designer_components,
        yui_designer_event,
        yui_image_sources,
        yui_image_preview,
        yui_designer_reset,
        yui_event_handler,
        pty_spawn,
        pty_write,
        pty_resize,
        pty_kill,
        list_shells,
        dir_list,
        dir_create_file,
        dir_create_dir,
        dir_rename,
        dir_remove,
        dir_copy,
        file_read,
        file_write,
        allow_path,
        path_info,
        path_set_readonly,
        mod_manifest_read,
        mod_manifest_set,
        project_open,
        project_close,
        workspace_load,
        workspace_save,
        app_state_load,
        app_state_save,
        format_supported,
        format_document,
        workflow_list,
        workflow_run,
        workflow_cancel,
        mod_run_targets,
        mod_run,
        mod_build,
        mod_clean,
        mod_hot_reload,
        publish_profiles_list,
        publish_profile_save,
        publish_profile_delete,
        publish_run,
        debugger::debug_stop,
        debugger::debug_set_breakpoint,
        debugger::debug_clear_breakpoint,
        debugger::debug_continue,
        debugger::debug_step,
        debugger::debug_select_thread,
        debugger::debug_variables,
        debugger::debug_evaluate,
        debugger::debug_children,
        debugger::debug_pause,
        debugger::debug_grant_ptrace_capability,
        app_restart,
        debug_supported,
        search::find_in_files,
        search::find_cancel,
        search::replace_in_files,
        symbols::code_search,
        environment::environment_detect,
        environment::environment_settings_set,
        environment::environment_run_presets,
        environment::environment_install,
        environment::environment_cancel,
        project_properties_read,
        project_properties_set_field,
        project_properties_set_yog_api,
        project_dependency_set,
        project_dependency_remove,
        project_run_target_set,
        project_run_target_remove,
        project_build_targets_set,
        crates_search,
        git::git_status,
        git::git_stage,
        git::git_unstage,
        git::git_discard,
        git::git_commit,
        git::git_last_message,
        git::git_diff_texts,
        git::git_head_text,
        git::git_log,
        git::git_commit_files,
        git::git_branches,
        git::git_switch,
        git::git_branch_create,
        git::git_branch_delete,
        git::git_remote,
        git::git_integrate,
        git::git_operation,
        git::git_clone,
        git::git_init,
        git::git_stash_list,
        git::git_stash_push,
        git::git_stash_op,
        git::git_config_get,
        git::git_config_set,
    ]);

    builder
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            // The game outlives the IDE; only a debugger has to let go.
            if let tauri::RunEvent::Exit = event {
                debugger::detach_on_exit(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_targets_read_toml_values() {
        let text = "[mod]\nname = \"Ruby\"\n\n[run.b]\ncommand = \"cargo\" # build\nargs = [\"run\", \"--features=a,b\"]\n\n[run.a]\nname = \"Client\"\n";
        let targets = parse_mod_run_targets(text);
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].name, "a");
        assert_eq!(targets[0].display_name.as_deref(), Some("Client"));
        assert_eq!(targets[1].display_name, None);
        assert_eq!(
            targets[1].description.as_deref(),
            Some("cargo run --features=a,b")
        );
    }
}
