//! Code: Find in Files, Code Search, formatting, the CLI.

use substrate_platform::commands::Domain;

pub const DOMAIN: Domain = Domain {
    key: "code",
    plugin: "yog-code",
    commands: &[
        "find_in_files",
        "project_items",
        "project_files_containing",
        "find_cancel",
        "replace_in_files",
        "code_search",
        "format_supported",
        "format_document",
        "cli",
    ],
};
