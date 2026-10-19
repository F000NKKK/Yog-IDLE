//! A mod project: its manifest, Project Properties, a path's properties, opening it.

use substrate_platform::commands::Domain;

pub const DOMAIN: Domain = Domain {
    key: "project",
    plugin: "yog-project",
    commands: &[
        "path_info",
        "path_set_readonly",
        "mod_manifest_read",
        "mod_manifest_set",
        "project_open",
        "project_close",
        "project_properties_read",
        "project_properties_set_field",
        "project_properties_set_yog_api",
        "project_dependency_set",
        "project_dependency_remove",
        "project_build_targets_set",
        "crates_search",
    ],
};
