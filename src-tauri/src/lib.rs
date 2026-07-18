use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use substrate_platform::{EntryKind, Level, LogLine, LogSink, Project, ProjectStandard, PtySession, Solution, WorkflowFile};
use tauri::{AppHandle, Emitter, State};

/// Every path a `dir_*`/workflow command may touch must resolve under one of
/// these — populated by `solution_open`. An IDE should never read/write
/// outside a project the user actually opened; this boundary is deliberately
/// enforced here rather than in `substrate-platform`, which stays
/// path-policy-agnostic.
#[derive(Default)]
struct AppState {
    project_roots: Mutex<Vec<PathBuf>>,
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
            _ => return Err(format!("path '{}' does not resolve to anything on disk", path.display())),
        }
    };
    if roots.iter().any(|root| canonical.starts_with(root)) {
        Ok(())
    } else {
        Err(format!("path '{}' is outside any open project", path.display()))
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

#[tauri::command]
fn file_read(state: State<AppState>, path: String) -> Result<String, String> {
    let target = PathBuf::from(&path);
    validate_within_roots(&state, &target)?;
    substrate_platform::dir::read_file(&target).map_err(|e| e.to_string())
}

#[tauri::command]
fn file_write(state: State<AppState>, path: String, contents: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    validate_within_roots(&state, &target)?;
    substrate_platform::dir::write_file(&target, &contents).map_err(|e| e.to_string())
}

/// Expands the allowed-path boundary to cover `path` — used by "Open File...",
/// where the user explicitly picked a file via a native OS dialog outside any
/// currently open project. That deliberate picker interaction is itself the
/// trust signal (same principle `solution_open` already relies on for
/// whatever folder/`.yogsln` it's pointed at), unlike a path a script merely
/// asked for on its own.
#[tauri::command]
fn allow_path(state: State<AppState>, path: String) -> Result<(), String> {
    let canonical = PathBuf::from(&path).canonicalize().map_err(|e| e.to_string())?;
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
    toml::from_str::<StandardsFile>(BUILT_IN_STANDARDS_TOML).map(|f| f.standard).unwrap_or_default()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectOut {
    name: String,
    root: String,
    kind: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SolutionOut {
    name: String,
    projects: Vec<ProjectOut>,
}

/// Opens `path` as a solution — a `.yogsln` file loads as-is; a bare folder
/// is auto-detected against `built_in_standards()` and wrapped as a
/// single-project solution in memory (nothing is written to disk unless the
/// user later saves a `.yogsln`). Every project's root becomes an allowed
/// path boundary for `dir_*`/workflow commands.
#[tauri::command]
fn solution_open(state: State<AppState>, path: String) -> Result<SolutionOut, String> {
    let requested = PathBuf::from(&path);
    let canonical = requested.canonicalize().map_err(|e| e.to_string())?;

    let solution = if canonical.extension().is_some_and(|ext| ext == "yogsln") {
        Solution::load(&canonical).map_err(|e| e.to_string())?
    } else {
        let kind = ProjectStandard::detect(&canonical, &built_in_standards());
        let name = canonical.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Solution".to_string());
        Solution { name: name.clone(), projects: vec![Project { name, root: canonical.clone(), kind }] }
    };

    {
        let mut roots = state.project_roots.lock().unwrap();
        for project in &solution.projects {
            if let Ok(canon) = project.root.canonicalize() {
                if !roots.contains(&canon) {
                    roots.push(canon);
                }
            }
        }
    }

    Ok(SolutionOut {
        name: solution.name,
        projects: solution
            .projects
            .into_iter()
            .map(|p| ProjectOut { name: p.name, root: p.root.to_string_lossy().into_owned(), kind: p.kind })
            .collect(),
    })
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
fn workflow_list(project_root: String) -> Result<Vec<WorkflowSummary>, String> {
    let file = resolve_workflow_file(&PathBuf::from(project_root))?;
    let mut list: Vec<WorkflowSummary> =
        file.workflow.into_iter().map(|(name, def)| WorkflowSummary { name, description: def.description }).collect();
    list.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(list)
}

fn format_log_line(line: &LogLine) -> String {
    match line.level {
        Level::Info => line.text.clone(),
        Level::Warn => format!("[warn] {}", line.text),
        Level::Error => format!("[error] {}", line.text),
    }
}

/// Shared "run this workflow's named entry, stream its output live, fire
/// `workflow-exit` when done" body — `workflow_run`, `mod_run`, and
/// `publish_run` all funnel through this instead of each re-wiring the
/// sink/event plumbing themselves.
fn run_and_stream(app: AppHandle, file: WorkflowFile, name: String, vars: HashMap<String, String>, root: PathBuf) {
    let sink = LogSink::new();
    let out_app = app.clone();
    sink.on_push(move |line| {
        let _ = out_app.emit("workflow-output", format_log_line(line));
    });

    let handle = substrate_platform::run_workflow(file, name, vars, root, sink);
    std::thread::spawn(move || {
        while handle.is_running() {
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = app.emit("workflow-exit", ());
    });
}

/// Runs `name` in the background (non-blocking) — output streams live via
/// the `workflow-output` event (one plain-string line each, same contract
/// `OutputPanel` already listens for) and a `workflow-exit` event fires once
/// every step has finished, mirroring the existing `pty-output`/`pty-exit`
/// pattern.
#[tauri::command]
fn workflow_run(app: AppHandle, project_root: String, name: String, vars: HashMap<String, String>) -> Result<(), String> {
    let root = PathBuf::from(project_root);
    let file = resolve_workflow_file(&root)?;
    run_and_stream(app, file, name, vars, root);
    Ok(())
}

/// Builds a one-step `WorkflowFile` at runtime (a single named entry called
/// "run") — for commands (`yog run <name>`, `yog build`, `yog publish
/// exports`) that don't need a whole `workflow.toml` of their own, just the
/// engine's existing process-streaming plumbing.
fn single_step_workflow(program: &str, args: Vec<String>) -> WorkflowFile {
    let mut workflow = HashMap::new();
    workflow.insert(
        "run".to_string(),
        substrate_platform::WorkflowDef {
            description: None,
            steps: vec![substrate_platform::WorkflowStep::Run { run: program.to_string(), args, cwd: None, env: HashMap::new() }],
        },
    );
    WorkflowFile { workflow }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModRunTarget {
    name: String,
    description: Option<String>,
}

/// Reads `yog.toml`'s `[run.<name>]` sections — plain named script-invocation
/// configs (like VS Code's `tasks.json`), not loader/Minecraft-version
/// settings. `yog run <name>` (yog-cli's own command) does the actual
/// build+export+launch; this only lists what's available.
#[tauri::command]
fn mod_run_targets(project_root: String) -> Result<Vec<ModRunTarget>, String> {
    let path = PathBuf::from(&project_root).join("yog.toml");
    let contents = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let value: toml::Value = contents.parse().map_err(|e: toml::de::Error| e.to_string())?;

    let mut targets = Vec::new();
    if let Some(run) = value.get("run").and_then(|v| v.as_table()) {
        for (name, cfg) in run {
            let description = cfg.get("command").and_then(|c| c.as_str()).map(|command| {
                let args: Vec<String> = cfg
                    .get("args")
                    .and_then(|a| a.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                format!("{command} {}", args.join(" "))
            });
            targets.push(ModRunTarget { name: name.clone(), description });
        }
    }
    targets.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(targets)
}

/// Runs a `[run.<name>]` target via `yog run <name>`.
#[tauri::command]
fn mod_run(app: AppHandle, project_root: String, name: String) -> Result<(), String> {
    let root = PathBuf::from(project_root);
    let file = single_step_workflow("yog", vec!["run".to_string(), name.clone()]);
    run_and_stream(app, file, "run".to_string(), HashMap::new(), root);
    Ok(())
}

/// The Build menu's plain "Build" action for a `yog-mod` project — `yog build`.
#[tauri::command]
fn mod_build(app: AppHandle, project_root: String) -> Result<(), String> {
    let root = PathBuf::from(project_root);
    let file = single_step_workflow("yog", vec!["build".to_string()]);
    run_and_stream(app, file, "run".to_string(), HashMap::new(), root);
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
    project_root.join(".yog-idle").join("publish-profiles")
}

/// Adds `.yog-idle/` to the project's `.gitignore` the first time a profile
/// is saved — publish profiles are local developer configuration (the same
/// reason people gitignore Visual Studio's own PublishProfiles), not
/// something that belongs in version control by default.
fn ensure_gitignored(project_root: &Path) {
    let gitignore_path = project_root.join(".gitignore");
    let entry = ".yog-idle/";
    let existing = std::fs::read_to_string(&gitignore_path).unwrap_or_default();
    if existing.lines().any(|line| line.trim() == entry) {
        return;
    }
    let mut updated = existing;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str(entry);
    updated.push('\n');
    let _ = std::fs::write(&gitignore_path, updated);
}

#[tauri::command]
fn publish_profiles_list(project_root: String) -> Result<Vec<PublishProfile>, String> {
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
fn publish_profile_save(project_root: String, profile: PublishProfile) -> Result<(), String> {
    let root = PathBuf::from(&project_root);
    let dir = publish_profiles_dir(&root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", profile.id));
    let json = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;
    ensure_gitignored(&root);
    Ok(())
}

#[tauri::command]
fn publish_profile_delete(project_root: String, id: String) -> Result<(), String> {
    let path = publish_profiles_dir(&PathBuf::from(project_root)).join(format!("{id}.json"));
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn publish_run(app: AppHandle, project_root: String, profile: PublishProfile) -> Result<(), String> {
    let root = PathBuf::from(project_root);
    let (program, args) = match profile.mode.as_str() {
        "exports" => {
            let mut args = vec!["publish".to_string(), "exports".to_string()];
            if profile.dry_run {
                args.push("--dry-run".to_string());
            }
            ("yog".to_string(), args)
        }
        _ => ("yog".to_string(), vec!["build".to_string()]),
    };
    let file = single_step_workflow(&program, args);
    run_and_stream(app, file, "run".to_string(), HashMap::new(), root);
    Ok(())
}

/// A shell available to spawn, serialized for the frontend's "new terminal" menu.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellInfo {
    id: String,
    label: String,
    command: String,
    clear_command: String,
}

#[tauri::command]
fn list_shells() -> Vec<ShellInfo> {
    substrate_platform::detect_shells()
        .into_iter()
        .map(|s| ShellInfo { id: s.id, label: s.label, command: s.command, clear_command: s.clear_command })
        .collect()
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
fn pty_spawn(app: AppHandle, state: State<PtyState>, id: String, cols: u16, rows: u16, shell: Option<String>) -> Result<(), String> {
    let out_app = app.clone();
    let out_id = id.clone();
    let exit_app = app.clone();
    let exit_id = id.clone();
    let session = PtySession::spawn(
        shell,
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
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyState::default())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
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
            file_read,
            file_write,
            allow_path,
            solution_open,
            workflow_list,
            workflow_run,
            mod_run_targets,
            mod_run,
            mod_build,
            publish_profiles_list,
            publish_profile_save,
            publish_profile_delete,
            publish_run,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
