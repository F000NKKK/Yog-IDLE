//! Yog IDLE's own commands as plugins, one per domain (names: `plugin_names.rs`;
//! their permissions: `build.rs`, which lists the same commands).

use crate::plugin_names::{APP, CODE, DEBUG, PROJECT, RUN};
use tauri::Wry;
use tauri::plugin::{Builder, TauriPlugin};

/// A mod project: its manifest, Project Properties, a path's properties, opening it.
pub fn project() -> TauriPlugin<Wry> {
    Builder::new(PROJECT)
        .invoke_handler(tauri::generate_handler![
            crate::path_commands::path_info,
            crate::path_commands::path_set_readonly,
            crate::path_commands::mod_manifest_read,
            crate::path_commands::mod_manifest_set,
            crate::project_commands::project_open,
            crate::project_commands::project_close,
            crate::project_commands::project_properties_read,
            crate::project_commands::project_properties_set_field,
            crate::project_commands::project_properties_set_yog_api,
            crate::project_commands::project_dependency_set,
            crate::project_commands::project_dependency_remove,
            crate::project_commands::project_build_targets_set,
            crate::project_commands::crates_search,
        ])
        .build()
}

/// Building, running, hot-reloading and publishing the mod; workflows.
pub fn run() -> TauriPlugin<Wry> {
    Builder::new(RUN)
        .invoke_handler(tauri::generate_handler![
            crate::workflow::workflow_list,
            crate::workflow::workflow_run,
            crate::workflow::workflow_cancel,
            crate::mod_commands::mod_run_targets,
            crate::mod_commands::mod_run,
            crate::mod_commands::mod_build,
            crate::mod_commands::mod_clean,
            crate::mod_commands::mod_hot_reload,
            crate::mod_commands::mod_hot_reload_decide,
            crate::publish::publish_profiles_list,
            crate::publish::publish_profile_save,
            crate::publish::publish_profile_delete,
            crate::publish::publish_run,
        ])
        .build()
}

/// The debugger.
pub fn debug() -> TauriPlugin<Wry> {
    Builder::new(DEBUG)
        .invoke_handler(tauri::generate_handler![
            crate::mod_commands::debug_supported,
            crate::debugger::debug_stop,
            crate::debugger::debug_set_breakpoint,
            crate::debugger::debug_clear_breakpoint,
            crate::debugger::debug_continue,
            crate::debugger::debug_step,
            crate::debugger::debug_select_thread,
            crate::debugger::debug_variables,
            crate::debugger::debug_evaluate,
            crate::debugger::debug_children,
            crate::debugger::debug_pause,
            crate::debugger::debug_grant_ptrace_capability,
        ])
        .build()
}

/// Code: Find in Files, Code Search, formatting, the CLI.
pub fn code() -> TauriPlugin<Wry> {
    Builder::new(CODE)
        .invoke_handler(tauri::generate_handler![
            crate::search::find_in_files,
            crate::search::project_items,
            crate::search::project_files_containing,
            crate::search::find_cancel,
            crate::search::replace_in_files,
            crate::symbols::code_search,
            crate::format::format_supported,
            crate::format::format_document,
            crate::format::cli,
        ])
        .build()
}

/// The app: remembered state, tools and Yog Installer, restarting.
pub fn app() -> TauriPlugin<Wry> {
    Builder::new(APP)
        .invoke_handler(tauri::generate_handler![
            crate::state_files::workspace_load,
            crate::state_files::workspace_save,
            crate::state_files::app_state_load,
            crate::state_files::app_state_save,
            crate::tools::tools_settings_set,
            crate::tools::tools_status,
            crate::tools::open_installer,
            crate::app_restart,
        ])
        .build()
}
