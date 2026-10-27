//! Code: Code Search, formatting, the CLI.

use tauri::Wry;
use tauri::plugin::{Builder, TauriPlugin};

use super::commands::code::DOMAIN;

pub fn plugin() -> TauriPlugin<Wry> {
    Builder::new(DOMAIN.plugin)
        .invoke_handler(tauri::generate_handler![
            crate::symbols::code_search,
            crate::toolchain::format::format_supported,
            crate::toolchain::format::format_document,
            crate::toolchain::format::cli,
        ])
        .build()
}
