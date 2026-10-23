//! Every event the backend emits to the front end, by name — the one list:
//! `build.rs` includes this file and writes the front end's copy
//! (`src/host.generated.ts`, `yogEvents`).

// The Output panel's sources — one event each, picked from its "Show output
// from" dropdown. Each payload is one line of text.
/// Builds and workflows.
pub const OUTPUT_BUILD: &str = "workflow-output";
/// The running game's own output.
pub const OUTPUT_GAME: &str = "game-output";
/// The debugger's messages (Linux only so far; the frontend lists it everywhere).
pub const OUTPUT_DEBUG: &str = "debug-output";

/// A Build/Publish workflow (or a run's build) started, for project `root`.
pub const WORKFLOW_START: &str = "workflow-start";
/// A workflow finished — or, payload-less, the game exited.
pub const WORKFLOW_EXIT: &str = "workflow-exit";
/// The launched game's lifecycle stage (starting/running/exited) and mods.
pub const GAME_STATUS: &str = "game-status";
/// One diagnostic a `yog` run found: a Yog Data frame's bytes (`yog_data::Diagnostic`).
pub const BUILD_DIAGNOSTIC: &str = "build-diagnostic";
/// A hot reload's result.
pub const HOT_RELOAD: &str = "hot-reload";

/// The debugger attached to the game.
pub const DEBUG_ATTACHED: &str = "debug-attached";
/// Attaching the debugger failed.
pub const DEBUG_ATTACH_FAILED: &str = "debug-attach-failed";
/// The debuggee stopped (breakpoint, step, pause, signal) or exited.
pub const DEBUG_STOPPED: &str = "debug-stopped";
/// The debugger itself failed mid-session.
pub const DEBUG_FAILED: &str = "debug-failed";

/// Every event, for the front end's copy: (name in code, event).
pub const ALL: &[(&str, &str)] = &[
    ("buildOutput", OUTPUT_BUILD),
    ("gameOutput", OUTPUT_GAME),
    ("debugOutput", OUTPUT_DEBUG),
    ("workflowStart", WORKFLOW_START),
    ("workflowExit", WORKFLOW_EXIT),
    ("gameStatus", GAME_STATUS),
    ("buildDiagnostic", BUILD_DIAGNOSTIC),
    ("hotReload", HOT_RELOAD),
    ("debugAttached", DEBUG_ATTACHED),
    ("debugAttachFailed", DEBUG_ATTACH_FAILED),
    ("debugStopped", DEBUG_STOPPED),
    ("debugFailed", DEBUG_FAILED),
];
