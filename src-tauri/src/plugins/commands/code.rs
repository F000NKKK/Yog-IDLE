//! Code: Code Search, formatting, the CLI.

use substrate_platform::commands::Domain;

pub const DOMAIN: Domain = Domain {
    key: "code",
    plugin: "yog-code",
    commands: &["code_search", "format_supported", "format_document", "cli"],
};
