//! The app: tools and Yog Installer, restarting.

use super::commands::app::DOMAIN;
use tauri::Wry;
use tauri::plugin::{Builder, TauriPlugin};

pub fn plugin() -> TauriPlugin<Wry> {
    Builder::new(DOMAIN.plugin)
        .invoke_handler(tauri::generate_handler![
            crate::tools::tools_settings_set,
            crate::tools::tools_status,
            crate::tools::open_installer,
            crate::app_commands::app_restart,
        ])
        .build()
}
