//! Running `yog` and workflows, their output streamed to the IDE.

use substrate_platform::sync::Locked;
use super::*;

/// A generic escape hatch open to any project (regardless of `kind`): if it
/// happens to define its own `workflow.toml`, its named entries can be run —
/// no built-in default ships anymore now that Yog-Mod-Loader isn't a project
/// standard here.
pub(super) fn resolve_workflow_file(project_root: &Path) -> Result<WorkflowFile, String> {
    let project_workflow = project_root.join("workflow.toml");
    if !project_workflow.exists() {
        return Err("this project has no workflow.toml".to_string());
    }
    let contents = std::fs::read_to_string(&project_workflow).map_err(|e| e.to_string())?;
    WorkflowFile::parse(&contents).map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkflowSummary {
    pub(super) name: String,
    pub(super) description: Option<String>,
}

#[tauri::command]
pub(super) fn workflow_list(
    state: State<Workspace>,
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

pub(super) fn format_log_line(line: &LogLine) -> String {
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
pub(super) struct WorkflowState {
    pub(super) next_id: AtomicU64,
    pub(super) running: Mutex<HashMap<u64, WorkflowHandle>>,
}

/// Payload of `workflow-start` — the project the run builds (the Error List
/// resolves the build's relative paths against it).
#[derive(Clone, Serialize)]
pub(super) struct WorkflowStart {
    pub(super) root: String,
}

impl WorkflowStart {
    pub(super) fn of(root: &Path) -> Self {
        Self {
            root: root.to_string_lossy().into_owned(),
        }
    }
}

/// Payload of `workflow-exit` for a workflow run — how it ended.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkflowExit {
    pub(super) success: bool,
    pub(super) cancelled: bool,
}

/// Shared "run this workflow's named entry, stream its output live, fire
/// `workflow-start` now and `workflow-exit` (with a `WorkflowExit`) when
/// done" body — `workflow_run`, `mod_build`, and
/// `publish_run` all funnel through this instead of each re-wiring the
/// sink/event plumbing themselves.
pub(super) fn run_and_stream(
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
    let handle = substrate_platform::run::run_workflow(file, name, vars, root, sink);
    let state = app.state::<WorkflowState>();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.running.locked().insert(id, handle.clone());
    std::thread::spawn(move || {
        let result = handle.wait();
        app.state::<WorkflowState>()
            .running
            .locked()
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
pub(super) fn workflow_cancel(state: State<WorkflowState>) {
    for handle in state.running.locked().values() {
        handle.cancel();
    }
}

/// Runs `name` in the background (non-blocking) — output streams live via
/// the `workflow-output` event (one plain-string line each, same contract
/// `OutputPanel` already listens for) and a `workflow-exit` event fires once
/// every step has finished, mirroring the terminal's output/exit
/// pattern.
#[tauri::command]
pub(super) fn workflow_run(
    app: AppHandle,
    state: State<Workspace>,
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
pub(super) fn single_step_workflow(
    program: &str,
    args: Vec<String>,
    env: HashMap<String, String>,
) -> WorkflowFile {
    let mut workflow = HashMap::new();
    workflow.insert(
        "run".to_string(),
        substrate_platform::run::WorkflowDef {
            description: None,
            steps: vec![substrate_platform::run::WorkflowStep::Run {
                run: program.to_string(),
                args,
                cwd: None,
                env,
            }],
        },
    );
    WorkflowFile { workflow }
}
