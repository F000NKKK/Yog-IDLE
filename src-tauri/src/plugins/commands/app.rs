//! The app: tools and Yog Installer, restarting.

use substrate_host_contract::commands::Domain;

pub const DOMAIN: Domain = Domain {
    key: "app",
    plugin: "yog-app",
    commands: &[
        "tools_settings_set",
        "tools_status",
        "open_installer",
        "app_restart",
    ],
};
