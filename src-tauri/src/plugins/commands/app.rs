//! The app: remembered state, tools and Yog Installer, restarting.

use substrate_platform::commands::Domain;

pub const DOMAIN: Domain = Domain {
    key: "app",
    plugin: "yog-app",
    commands: &[
        "workspace_load",
        "workspace_save",
        "app_state_load",
        "app_state_save",
        "tools_settings_set",
        "tools_status",
        "open_installer",
        "app_restart",
    ],
};
