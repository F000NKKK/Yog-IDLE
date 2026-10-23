//! The app: tools and Yog Installer, restarting.

use super::commands::app::DOMAIN;
use tauri::Wry;
use tauri::plugin::{Builder, TauriPlugin};

pub fn plugin() -> TauriPlugin<Wry> {
    Builder::new(DOMAIN.plugin)
        .invoke_handler(tauri::generate_handler![
            crate::toolchain::tools::tools_settings_set,
            crate::toolchain::tools::tools_status,
            crate::toolchain::tools::open_installer,
            crate::app::app_commands::app_restart,
        ])
        .build()
}
