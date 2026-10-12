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

mod properties;
mod search;
mod symbols;

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
    validate_within_roots(&state, &root.join("yog.toml"))?;
    properties::set_manifest_field(&root, &key, value)
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
    project_root.join(".yog-idle")
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
fn formatter_for(path: &Path) -> Option<(&'static str, &'static [&'static str])> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "rs" => Some(("rustfmt", &["--edition", "2021", "--emit", "stdout"])),
        "toml" => Some(("taplo", &["fmt", "-"])),
        _ => None,
    }
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

/// The Output panel's sources — one event each, picked from its "Show
/// output from" dropdown: builds and workflows, the running game's own
/// output, and the debugger's messages.
pub(crate) const OUTPUT_BUILD: &str = "workflow-output";
pub(crate) const OUTPUT_GAME: &str = "game-output";
pub(crate) const OUTPUT_DEBUG: &str = "debug-output";

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
                OUTPUT_GAME
            } else {
                launched = text.starts_with("==> launched pid ");
                OUTPUT_BUILD
            };
            let _ = app.emit(event, format_stderr_line(text));
        }
        // A last line the run never finished.
        if !line.is_empty() {
            let event = if launched { OUTPUT_GAME } else { OUTPUT_BUILD };
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
        let _ = out_app.emit("workflow-output", format_log_line(line));
    });

    let handle = substrate_platform::run_workflow(file, name, vars, root, sink);
    let state = app.state::<WorkflowState>();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.running.lock().unwrap().insert(id, handle.clone());
    let _ = app.emit("workflow-start", ());
    std::thread::spawn(move || {
        let result = handle.wait();
        app.state::<WorkflowState>()
            .running
            .lock()
            .unwrap()
            .remove(&id);
        let _ = app.emit(
            "workflow-exit",
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
fn single_step_workflow(program: &str, args: Vec<String>) -> WorkflowFile {
    let mut workflow = HashMap::new();
    workflow.insert(
        "run".to_string(),
        substrate_platform::WorkflowDef {
            description: None,
            steps: vec![substrate_platform::WorkflowStep::Run {
                run: program.to_string(),
                args,
                cwd: None,
                env: HashMap::new(),
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
        if let Some(value) = line
            .strip_prefix("name")
            .and_then(|rest| rest.trim_start().strip_prefix('='))
        {
            *display_name = Some(value.trim().trim_matches('"').to_string());
        } else if let Some(value) = line
            .strip_prefix("command")
            .and_then(|rest| rest.trim_start().strip_prefix('='))
        {
            *command = Some(value.trim().trim_matches('"').to_string());
        } else if let Some(value) = line
            .strip_prefix("args")
            .and_then(|rest| rest.trim_start().strip_prefix('='))
        {
            *args = value
                .trim()
                .trim_start_matches('[')
                .trim_end_matches(']')
                .split(',')
                .map(|s| s.trim().trim_matches('"').to_string())
                .filter(|s| !s.is_empty())
                .collect();
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
    let path = PathBuf::from(&project_root).join("yog.toml");
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

/// The Build menu's plain "Build" action for a `yog-mod` project — `yog build`.
#[tauri::command]
fn mod_build(app: AppHandle, state: State<AppState>, project_root: String) -> Result<(), String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    let file = single_step_workflow("yog", vec!["build".to_string()]);
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
    let _ = app.emit("workflow-start", ());
    let out_app = app.clone();
    let success = tauri::async_runtime::spawn_blocking(move || {
        let mut success = true;
        for dir in ["target", ".yog-build", "artifacts"] {
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
            let _ = out_app.emit("workflow-output", line);
        }
        success
    })
    .await
    .unwrap_or(false);
    let _ = app.emit(
        "workflow-exit",
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
    let (program, args) = match profile.mode.as_str() {
        "exports" => {
            let mut args = vec!["publish".to_string(), "exports".to_string()];
            if profile.dry_run {
                args.push("--dry-run".to_string());
            }
            ("yog".to_string(), args)
        }
        "package" => ("yog".to_string(), vec!["build".to_string()]),
        other => return Err(format!("unknown publish mode '{other}'")),
    };
    let file = single_step_workflow(&program, args);
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
fn pty_spawn(
    app: AppHandle,
    state: State<PtyState>,
    app_state: State<AppState>,
    id: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
) -> Result<(), String> {
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
            cwd: app_state.current_project.lock().unwrap().clone(),
            ..PtyOptions::default()
        },
        cols,
        rows,
        move |data| {
            let _ = out_app.emit(
                "pty-output",
                PtyOutput {
                    id: out_id.clone(),
                    data,
                },
            );
        },
        move || {
            let _ = exit_app.emit(
                "pty-exit",
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        .manage(search::SearchState::default())
        .manage(symbols::SymbolIndexState::default());

    let builder = builder.manage(debugger::DebugState::default());

    let builder = builder.invoke_handler(tauri::generate_handler![
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
        debugger::debug_pause,
        debugger::debug_grant_ptrace_capability,
        debugger::app_restart,
        debug_supported,
        search::find_in_files,
        search::find_cancel,
        search::replace_in_files,
        symbols::code_search,
    ]);

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // The game outlives the IDE; only a debugger has to let go.
            if let tauri::RunEvent::Exit = event {
                debugger::detach_on_exit(app);
            }
        });
}
