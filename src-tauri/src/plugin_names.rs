// Yog IDLE's own plugins — its commands by domain, each with its handler
// (`plugins.rs`) and permissions (`build.rs`, which includes this file and
// writes the front end's copy, `plugins.generated.ts`).

/// A mod project: its manifest, Project Properties, a path's properties, opening it.
pub const PROJECT: &str = "yog-project";
/// Building, running, hot-reloading and publishing the mod; workflows.
pub const RUN: &str = "yog-run";
/// The debugger.
pub const DEBUG: &str = "yog-debug";
/// Code: Find in Files, Code Search, formatting, the CLI.
pub const CODE: &str = "yog-code";
/// The app: remembered state, tools and Yog Installer, restarting.
pub const APP: &str = "yog-app";
