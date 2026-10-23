//! A mod project's on-disk layout as Yog-IDLE sees it — the `yog.toml`
//! manifest at its root, `yog`'s build folder, and Yog-IDLE's own folder —
//! and reading the manifest's `[mod]` fields.

use std::path::{Path, PathBuf};

/// The mod manifest, at a mod project's root.
pub const MANIFEST: &str = yog_ids::file::MANIFEST;
/// What `yog build` makes on the way (the generated crate, generated code,
/// cargo's target) and what it makes (the `.yog`).
pub const OBJ_DIR: &str = yog_ids::project::OBJ;
pub const BIN_DIR: &str = yog_ids::project::BIN;
/// Yog-IDLE's own per-project data (publish profiles, workspace state).
pub const IDLE_DIR: &str = ".yog-idle";

/// The generated code's files.
const GENERATED_EXTENSION: &str = "rs";

/// A Yog project as a search sees it: the build folder and IDLE's own data
/// skipped, the generated screen code searchable on request.
pub static SEARCH_LAYOUT: std::sync::LazyLock<substrate_platform::search::Layout> =
    std::sync::LazyLock::new(|| substrate_platform::search::Layout {
        skip_dirs: vec![OBJ_DIR.to_string(), BIN_DIR.to_string(), IDLE_DIR.to_string()],
        generated: vec![substrate_platform::search::Generated {
            dir: std::path::PathBuf::from(yog_ids::project::GENERATED),
            extension: GENERATED_EXTENSION.to_string(),
        }],
    });

/// `<root>/yog.toml`.
pub fn path(root: &Path) -> PathBuf {
    root.join(MANIFEST)
}

/// A string field of `[mod]` in `text`, a `yog.toml`'s contents — `None`
/// when it's missing or `text` isn't TOML.
pub fn mod_field(text: &str, key: &str) -> Option<String> {
    let doc: toml::Table = text.parse().ok()?;
    doc.get("mod")?.get(key)?.as_str().map(str::to_string)
}

/// [`mod_field`] of the `yog.toml` at `root`.
pub fn read_mod_field(root: &Path, key: &str) -> Option<String> {
    mod_field(&std::fs::read_to_string(path(root)).ok()?, key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mod_fields_ignore_comments_and_other_sections() {
        let text =
            "[mod]\nid = \"ruby\"  # the namespace\n\n[run.\"forge-1.21.1\"]\nname = \"Forge\"\n";
        assert_eq!(mod_field(text, "id").as_deref(), Some("ruby"));
        assert_eq!(mod_field(text, "name"), None);
        assert_eq!(mod_field("[package]\nid = \"old\"\n", "id"), None);
        assert_eq!(mod_field("not toml", "id"), None);
    }
}
