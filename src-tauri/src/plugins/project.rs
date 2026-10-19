//! A mod project: its manifest, Project Properties, a path's properties, opening it.

use super::commands::project::DOMAIN;
use tauri::Wry;
use tauri::plugin::{Builder, TauriPlugin};

pub fn plugin() -> TauriPlugin<Wry> {
    Builder::new(DOMAIN.plugin)
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
