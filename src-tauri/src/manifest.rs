//! A mod project's on-disk layout as Yog-IDLE sees it — the `yog.toml`
//! manifest at its root, `yog`'s build folder, and Yog-IDLE's own folder —
//! and reading the manifest's `[mod]` fields.

use std::path::{Path, PathBuf};

/// The mod manifest, at a mod project's root.
pub const MANIFEST: &str = "yog.toml";
/// Where `yog build` writes (the generated crate, generated code).
pub const BUILD_DIR: &str = ".yog-build";
/// Yog-IDLE's own per-project data (publish profiles, workspace state).
pub const IDLE_DIR: &str = ".yog-idle";

/// `<root>/yog.toml`.
pub fn path(root: &Path) -> PathBuf {
    root.join(MANIFEST)
}

/// The mod `file` belongs to: the nearest folder (itself included) with a `yog.toml`.
pub fn mod_root(file: &Path) -> Option<PathBuf> {
    file.ancestors()
        .find(|d| path(d).is_file())
        .map(Path::to_path_buf)
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
