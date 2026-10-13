//! Every event the backend emits to the frontend, by name — the frontend
//! listens for the same strings (mirrored in its own constants), so a
//! rename has to happen on both sides at once.

// The Output panel's sources — one event each, picked from its "Show output
// from" dropdown. Each payload is one line of text.
/// Builds and workflows.
pub const OUTPUT_BUILD: &str = "workflow-output";
/// The running game's own output.
pub const OUTPUT_GAME: &str = "game-output";
/// The debugger's messages (Linux only so far; the frontend lists it everywhere).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const OUTPUT_DEBUG: &str = "debug-output";
/// Environment installs.
pub const OUTPUT_ENVIRONMENT: &str = "environment-output";
/// Source Control's git commands.
pub const OUTPUT_GIT: &str = "git-output";

/// A Build/Publish workflow (or a run's build) started.
pub const WORKFLOW_START: &str = "workflow-start";
/// A workflow finished — or, payload-less, the game exited.
pub const WORKFLOW_EXIT: &str = "workflow-exit";
/// The launched game's lifecycle stage (starting/running/exited) and mods.
pub const GAME_STATUS: &str = "game-status";
/// A hot reload's result.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const HOT_RELOAD: &str = "hot-reload";

/// The debugger attached to the game.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const DEBUG_ATTACHED: &str = "debug-attached";
/// Attaching the debugger failed.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const DEBUG_ATTACH_FAILED: &str = "debug-attach-failed";
/// The debuggee stopped (breakpoint, step, pause, signal) or exited.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const DEBUG_STOPPED: &str = "debug-stopped";
/// The debugger itself failed mid-session.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const DEBUG_FAILED: &str = "debug-failed";

/// A terminal session's output chunk / its shell exited.
pub const PTY_OUTPUT: &str = "pty-output";
pub const PTY_EXIT: &str = "pty-exit";

/// Environment install progress, one component done, and the whole install done.
pub const ENVIRONMENT_PROGRESS: &str = "environment-progress";
pub const ENVIRONMENT_INSTALL_DONE: &str = "environment-install-done";
pub const ENVIRONMENT_INSTALL_FINISHED: &str = "environment-install-finished";
