//! Building, running, hot-reloading and publishing the mod; workflows.

use substrate_platform::commands::Domain;

pub const DOMAIN: Domain = Domain {
    key: "run",
    plugin: "yog-run",
    commands: &[
        "workflow_list",
        "workflow_run",
        "workflow_cancel",
        "mod_run_targets",
        "mod_run",
        "mod_build",
        "mod_clean",
        "mod_hot_reload",
        "mod_hot_reload_decide",
        "publish_profiles_list",
        "publish_profile_save",
        "publish_profile_delete",
        "publish_run",
    ],
};
