//! Yog IDLE's own commands as plugins, one per domain: each domain registers
//! its commands (`project.rs`, `run.rs`…) under the name and list it declares
//! in `commands/`; `all` gathers them for the app.

pub mod commands;

mod app;
mod code;
mod debug;
mod project;
mod run;

use tauri::Wry;
use tauri::plugin::TauriPlugin;

/// Every domain's plugin.
pub fn all() -> [TauriPlugin<Wry>; 5] {
    [project::plugin(), run::plugin(), debug::plugin(), code::plugin(), app::plugin()]
}
