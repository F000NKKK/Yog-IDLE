use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use substrate_platform::project::ProjectStandard;
use substrate_platform::run::{
    Level, LogLine, LogSink, WorkflowFile, WorkflowHandle, WorkflowResult,
};
use tauri::{AppHandle, Emitter, Manager, State};

mod path_commands;
pub mod plugins;
use path_commands::*;
mod app_commands;
mod format;
mod project_commands;
mod workflow;
use workflow::*;
mod mod_commands;
use mod_commands::*;
mod publish;

mod cli;
mod diagnostics_feed;
pub mod events;
mod manifest;
mod project_properties;
mod properties;
mod symbols;
mod tools;

mod debugger;

/// The folders IDLE may touch — the projects the user opened and files they
/// picked — kept by Substrate's plugin, which checks its own commands
/// against it; IDLE's commands check theirs with [`validate_within_roots`].
pub(crate) use tauri_plugin_substrate::Workspace;

#[cfg(feature = "bench")]
#[doc(hidden)]
pub mod bench;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> tauri::Result<()> {
    let context = tauri::generate_context!();
    // Before any thread exists: the Build options go into this process's
    // own environment, for every `yog`/`cargo` it starts.
    let build_settings = tools::default_state_file(&context.config().identifier)
        .map(|file| tools::load_settings_from(&file))
        .unwrap_or_default();
    tools::apply_to_process_at_startup(&build_settings);
    // Search and replace see Yog formats' files as the editor does.
    cli::register_text_views();

    let builder = tauri::Builder::default()
        // Substrate's own commands (the workspace, Source Control): what its UI calls.
        .plugin(tauri_plugin_substrate::init_with(
            tauri_plugin_substrate::Options {
                search: manifest::SEARCH_LAYOUT.clone(),
                state: Some(tauri_plugin_substrate::StateOptions {
                    project_dir: manifest::IDLE_DIR.to_string(),
                }),
            },
        ))
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
        .manage(WorkflowState::default())
        .manage(tools::ToolsState::new(build_settings))
        .manage(symbols::SymbolIndexState::default())
        .manage(debugger::DebugState::default());

    // Yog IDLE's own commands, a plugin per domain.
    let builder = plugins::all()
        .into_iter()
        .fold(builder, |builder, plugin| builder.plugin(plugin));

    builder.build(context)?.run(|app, event| {
        // The game outlives the IDE; only a debugger has to let go.
        if let tauri::RunEvent::Exit = event {
            debugger::detach_on_exit(app);
        }
    });
    Ok(())
}
