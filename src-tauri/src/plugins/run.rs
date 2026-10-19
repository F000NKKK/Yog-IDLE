//! Building, running, hot-reloading and publishing the mod; workflows.

use super::commands::run::DOMAIN;
use tauri::Wry;
use tauri::plugin::{Builder, TauriPlugin};

pub fn plugin() -> TauriPlugin<Wry> {
    Builder::new(DOMAIN.plugin)
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
