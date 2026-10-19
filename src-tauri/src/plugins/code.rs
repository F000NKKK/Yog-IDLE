//! Code: Find in Files, Code Search, formatting, the CLI.

use super::commands::code::DOMAIN;
use tauri::Wry;
use tauri::plugin::{Builder, TauriPlugin};

pub fn plugin() -> TauriPlugin<Wry> {
    Builder::new(DOMAIN.plugin)
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
