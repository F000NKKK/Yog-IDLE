use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use substrate_platform::project::ProjectStandard;
use substrate_platform::run::{Level, LogLine, LogSink, WorkflowFile, WorkflowHandle, WorkflowResult};
use tauri::{AppHandle, Emitter, Manager, State};

mod plugin_names;
mod plugins;
mod path_commands;
use path_commands::*;
mod project_commands;
use project_commands::*;
mod state_files;
use state_files::*;
mod format;
use format::*;
mod workflow;
use workflow::*;
mod mod_commands;
use mod_commands::*;
mod publish;
use publish::*;

mod cli;
mod tools;
mod events;
mod manifest;
mod project_properties;
mod properties;
mod search;
mod symbols;

mod debugger;

/// The folders IDLE may touch — the projects the user opened and files they
/// picked — kept by Substrate's plugin, which checks its own commands
/// against it; IDLE's commands check theirs with [`validate_within_roots`].
pub(crate) use tauri_plugin_substrate::Workspace;

/// Restarts Yog-IDLE — e.g. after `debug_grant_ptrace_capability`, which
/// only takes effect for a fresh `exec()`.
#[tauri::command]
pub(crate) fn app_restart(app: AppHandle) {
    app.restart();
}

/// The backend's hot paths for `benches/backend.rs` — not an API.
#[doc(hidden)]
pub mod bench {
    use std::path::{Path, PathBuf};

    pub use crate::search::OpenDocument;
    pub use crate::symbols::{extract_symbols, fuzzy_match};

    /// A call of the CLI service, as the front end makes it.
    pub fn cli(method: &str, params: serde_json::Value) -> Result<serde_json::Value, serde_json::Value> {
        crate::cli::call(method, params)
    }

    /// What Yog needs here and has (`tools_status`).
    pub fn tools_status() -> serde_json::Value {
        serde_json::to_value(crate::tools::tools_status()).unwrap_or_default()
    }

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
        let mut status = substrate_platform::git::status::parse_status(raw);
        substrate_platform::git::status::set_abs_paths(&mut status, top);
        serde_json::to_string(&status).unwrap()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // Before any thread exists: the Build options go into this process's
    // own environment, for every `yog`/`cargo` it starts.
    let build_settings = tools::default_state_file(&context.config().identifier)
        .map(|file| tools::load_settings_from(&file))
        .unwrap_or_default();
    tools::apply_to_process_at_startup(&build_settings);

    let builder = tauri::Builder::default()
        // Substrate's own commands (the workspace, Source Control): what its UI calls.
        .plugin(tauri_plugin_substrate::init())
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
        .manage(search::SearchState::default())
        .manage(symbols::SymbolIndexState::default());

    let builder = builder
        .manage(debugger::DebugState::default())
        // Yog IDLE's own commands, a plugin per domain.
        .plugin(plugins::project())
        .plugin(plugins::run())
        .plugin(plugins::debug())
        .plugin(plugins::code())
        .plugin(plugins::app());

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
