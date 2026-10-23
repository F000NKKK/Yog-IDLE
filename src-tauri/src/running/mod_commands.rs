//! Running, debugging, building and cleaning the mod.

use crate::*;

/// A run target as the Run toolbar's `RunBar` takes it: a loader (`group`)
/// on a Minecraft version (`variant`), or one of the machine's own.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModRunTarget {
    pub(crate) name: String,
    pub(crate) display_name: Option<String>,
    pub(crate) group: Option<String>,
    pub(crate) group_label: Option<String>,
    pub(crate) variant: Option<String>,
}

/// The run targets, the folders they're read from (to watch them), and
/// the machine's local patch they can be changed in.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModRunTargets {
    pub(crate) targets: Vec<ModRunTarget>,
    pub(crate) sources: Vec<String>,
    pub(crate) local_file: String,
}

/// The run targets — they come from Yog's home (the loader SDK,
/// `~/.yog/local.toml`), not the project.
#[tauri::command]
pub(crate) async fn mod_run_targets(
    state: State<'_, Workspace>,
    project_root: String,
) -> Result<ModRunTargets, String> {
    validate_within_roots(&state, Path::new(&project_root))?;
    tauri::async_runtime::spawn_blocking(move || {
        let home = yog_home::Home::locate()?;
        let resolver = yog_home::targets::Resolver::new(&home)?;
        let targets = resolver
            .targets()?
            .into_iter()
            .map(|t| ModRunTarget {
                name: t.id,
                display_name: Some(t.label),
                group: Some(t.group),
                group_label: Some(t.group_label),
                variant: t.variant,
            })
            .collect();
        Ok(ModRunTargets {
            targets,
            sources: resolver
                .sources(&home)
                .iter()
                .map(|p| p.display().to_string())
                .collect(),
            local_file: home.local_file().display().to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs a `[run.<name>]` target via `yog run <name>` — `mode` is
/// Yog-IDLE's own vocabulary (`"release"` | `"debug"`), opaque to
/// `RunBar`/the generic run-target machinery. It connects `yog-runtime`'s
/// control channel for live status and hot reload (a Debug run is the one
/// built for it), and on Linux a Debug run also attaches `yog-debugger` the
/// moment the game reports its real pid (see `debugger::run_with_mode`).
#[tauri::command]
pub(crate) fn mod_run(
    app: AppHandle,
    state: State<Workspace>,
    project_root: String,
    name: String,
    mode: String,
) -> Result<(), String> {
    validate_within_roots(&state, Path::new(&project_root))?;
    debugger::run_with_mode(app, project_root, name, mode)
}

/// The answer to a hot reload that needs a restart for part of it (the
/// dialog the `confirm` stage opens): `"apply"`, `"restart"` or `"cancel"`.
#[tauri::command]
pub(crate) fn mod_hot_reload_decide(app: AppHandle, choice: String) -> Result<(), String> {
    debugger::decide_hot_reload(app, choice)
}

/// The toolbar's Hot Reload: rebuilds the project and swaps the new build
/// into the running game over `yog-runtime`'s control channel — see
/// `debugger::hot_reload`.
#[tauri::command]
pub(crate) fn mod_hot_reload(
    app: AppHandle,
    state: State<Workspace>,
    project_root: String,
) -> Result<(), String> {
    validate_within_roots(&state, Path::new(&project_root))?;
    debugger::hot_reload(app, project_root)
}

/// A one-step `yog <args>` workflow run the way Tools > Options > Build
/// says, with the project's build platforms (`YOG_TARGETS`).
pub(crate) fn yog_workflow(app: &AppHandle, root: &Path, args: Vec<String>) -> WorkflowFile {
    let settings = app
        .state::<crate::toolchain::tools::ToolsState>()
        .settings();
    let env = crate::toolchain::tools::tool_env(
        &settings,
        &crate::project::project_properties::read_build_targets(root),
    );
    single_step_workflow(yog_ids::program::CLI, args, env)
}

/// The Build menu's plain "Build" action for a `yog-mod` project — `yog build`.
#[tauri::command]
pub(crate) fn mod_build(
    app: AppHandle,
    state: State<Workspace>,
    project_root: String,
) -> Result<(), String> {
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
pub(crate) async fn mod_clean(
    app: AppHandle,
    state: State<'_, Workspace>,
    project_root: String,
) -> Result<(), String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    let _ = app.emit(crate::app::events::WORKFLOW_START, WorkflowStart::of(&root));
    let out_app = app.clone();
    let success = tauri::async_runtime::spawn_blocking(move || {
        let mut success = true;
        for dir in ["target", crate::project::manifest::BUILD_DIR, "artifacts"] {
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
            let _ = out_app.emit(crate::app::events::OUTPUT_BUILD, line);
        }
        success
    })
    .await
    .unwrap_or(false);
    let _ = app.emit(
        crate::app::events::WORKFLOW_EXIT,
        WorkflowExit {
            success,
            cancelled: false,
        },
    );
    Ok(())
}
