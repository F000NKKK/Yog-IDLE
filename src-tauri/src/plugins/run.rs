//! Building, running, hot-reloading and publishing the mod; workflows.

use super::commands::run::DOMAIN;
use tauri::Wry;
use tauri::plugin::{Builder, TauriPlugin};

pub fn plugin() -> TauriPlugin<Wry> {
    Builder::new(DOMAIN.plugin)
        .invoke_handler(tauri::generate_handler![
            crate::running::workflow::workflow_list,
            crate::running::workflow::workflow_run,
            crate::running::workflow::workflow_cancel,
            crate::running::mod_commands::mod_run_targets,
            crate::running::mod_commands::mod_run,
            crate::running::mod_commands::mod_build,
            crate::running::mod_commands::mod_clean,
            crate::running::mod_commands::mod_hot_reload,
            crate::running::mod_commands::mod_hot_reload_decide,
            crate::project::publish::publish_profiles_list,
            crate::project::publish::publish_profile_save,
            crate::project::publish::publish_profile_delete,
            crate::project::publish::publish_run,
        ])
        .build()
}
