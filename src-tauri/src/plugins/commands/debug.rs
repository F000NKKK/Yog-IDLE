//! The debugger.

use substrate_platform::commands::Domain;

pub const DOMAIN: Domain = Domain {
    key: "debug",
    plugin: "yog-debug",
    commands: &[
        "debug_stop",
        "debug_set_breakpoint",
        "debug_clear_breakpoint",
        "debug_continue",
        "debug_step",
        "debug_select_thread",
        "debug_variables",
        "debug_evaluate",
        "debug_children",
        "debug_pause",
        "debug_grant_ptrace_capability",
    ],
};
