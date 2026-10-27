//! The debugger.

use tauri::Wry;
use tauri::plugin::{Builder, TauriPlugin};

use super::commands::debug::DOMAIN;

pub fn plugin() -> TauriPlugin<Wry> {
    Builder::new(DOMAIN.plugin)
        .invoke_handler(tauri::generate_handler![
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
