//! The app: remembered state, tools and Yog Installer, restarting.

use super::commands::app::DOMAIN;
use tauri::Wry;
use tauri::plugin::{Builder, TauriPlugin};

pub fn plugin() -> TauriPlugin<Wry> {
    Builder::new(DOMAIN.plugin)
        .invoke_handler(tauri::generate_handler![
            crate::state_files::workspace_load,
            crate::state_files::workspace_save,
            crate::state_files::app_state_load,
            crate::state_files::app_state_save,
            crate::tools::tools_settings_set,
            crate::tools::tools_status,
            crate::tools::open_installer,
            crate::state_files::app_restart,
        ])
        .build()
}
