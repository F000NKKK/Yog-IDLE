//! Backend for the Properties window: on-disk details of a file/folder
//! (`path_info`), and reading/editing a mod's `yog.toml` `[mod]` fields in
//! place (`mod_manifest_*`). Path-policy checks stay in `lib.rs`'s command
//! wrappers, like every other `dir_*`/`file_*` command.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use toml_edit::{DocumentMut, Item, Table, Value};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInfo {
    kind: &'static str,
    /// Bytes, for a file; `0` for a folder.
    size: u64,
    /// Milliseconds since the Unix epoch — `None` where the platform doesn't record it.
    modified: Option<u64>,
    created: Option<u64>,
    read_only: bool,
    /// A folder's direct children (files and folders), not recursive.
    item_count: Option<u64>,
    /// A folder with a `yog.toml` — shown as a mod project.
    is_mod_project: bool,
}

fn epoch_millis(time: std::io::Result<SystemTime>) -> Option<u64> {
    let since = time.ok()?.duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(since.as_millis()).ok()
}

pub fn path_info(path: &Path) -> Result<PathInfo, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let is_dir = meta.is_dir();
    let item_count = if is_dir {
        std::fs::read_dir(path)
            .ok()
            .map(|entries| entries.count() as u64)
    } else {
        None
    };
    Ok(PathInfo {
        kind: if is_dir { "dir" } else { "file" },
        size: if is_dir { 0 } else { meta.len() },
        modified: epoch_millis(meta.modified()),
        created: epoch_millis(meta.created()),
        read_only: meta.permissions().readonly(),
        item_count,
        is_mod_project: is_dir && crate::manifest::path(path).is_file(),
    })
}

/// Sets or clears a file's read-only flag. On Unix that's the owner's write
/// bit only — never making a file group/world-writable that wasn't.
pub fn set_read_only(path: &Path, read_only: bool) -> Result<(), String> {
    let mut permissions = std::fs::metadata(path)
        .map_err(|e| e.to_string())?
        .permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = permissions.mode();
        permissions.set_mode(if read_only {
            mode & !0o222
        } else {
            mode | 0o200
        });
    }
    #[cfg(not(unix))]
    permissions.set_readonly(read_only);
    std::fs::set_permissions(path, permissions).map_err(|e| e.to_string())
}

/// The `[mod]` keys the Properties window shows and edits (plus `authors`,
/// an array) — the same set `yog-cli` reads.
pub(crate) const TEXT_FIELDS: &[&str] = &[
    "id",
    "name",
    "version",
    "description",
    "license",
    "exports_license",
    "edition",
];

/// Removed from the file when set to an empty value — `yog-cli` has a
/// default for each.
const OPTIONAL_FIELDS: &[&str] = &["license", "exports_license", "edition"];

const EDITIONS: &[&str] = &["2015", "2018", "2021", "2024"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestOut {
    /// Every present key of `TEXT_FIELDS`.
    fields: BTreeMap<String, String>,
    authors: Vec<String>,
    dependencies: usize,
    mod_dependencies: usize,
    run_configs: usize,
    yog_api_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum FieldValue {
    Text(String),
    List(Vec<String>),
}

fn manifest_path(project_root: &Path) -> std::path::PathBuf {
    crate::manifest::path(project_root)
}

pub(crate) fn load(path: &Path) -> Result<DocumentMut, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let doc: DocumentMut = text
        .parse()
        .map_err(|e| format!("yog.toml isn't valid TOML: {e}"))?;
    if !doc.get("mod").is_some_and(Item::is_table) {
        return Err("yog.toml has no [mod] section".into());
    }
    Ok(doc)
}

fn table_len(doc: &DocumentMut, dotted: &[&str]) -> usize {
    let mut item = doc.as_item();
    for key in dotted {
        match item.get(key) {
            Some(next) => item = next,
            None => return 0,
        }
    }
    item.as_table_like().map_or(0, |t| t.iter().count())
}

pub(crate) fn summarize(doc: &DocumentMut) -> ManifestOut {
    let table = doc["mod"].as_table_like();
    let text = |key: &str| {
        table
            .and_then(|t| t.get(key))
            .and_then(Item::as_str)
            .map(str::to_string)
    };
    let fields = TEXT_FIELDS
        .iter()
        .filter_map(|key| text(key).map(|v| (key.to_string(), v)))
        .collect();
    let authors = table
        .and_then(|t| t.get("authors"))
        .and_then(Item::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    // `[dependencies]` also holds the `exports` sub-table and yog-api pins,
    // which aren't plain crate dependencies.
    let dependencies = doc
        .get("dependencies")
        .and_then(Item::as_table_like)
        .map_or(0, |t| {
            t.iter()
                .filter(|(k, v)| {
                    !v.is_table() && !matches!(*k, "yog_api_version" | "yog-api" | "yog_api")
                })
                .count()
        });
    ManifestOut {
        fields,
        authors,
        dependencies,
        mod_dependencies: table_len(doc, &["dependencies", "exports"]),
        run_configs: table_len(doc, &["run"]),
        yog_api_path: doc
            .get("dev")
            .and_then(|d| d.get("yog_api_path"))
            .and_then(Item::as_str)
            .map(str::to_string),
    }
}

pub fn read_manifest(project_root: &Path) -> Result<ManifestOut, String> {
    let doc = load(&manifest_path(project_root))?;
    Ok(summarize(&doc))
}

/// `yog-cli` reads `yog.toml` line by line and takes values verbatim
/// between the quotes — no escapes, no multi-line strings — so a value
/// must survive that, not just be valid TOML.
pub(crate) fn check_plain(value: &str) -> Result<(), String> {
    if value.contains(['"', '\\', '\n', '\r']) {
        return Err("Can't contain quotes, backslashes or line breaks (yog reads yog.toml values verbatim).".into());
    }
    Ok(())
}

fn check_field(key: &str, value: &str) -> Result<(), String> {
    check_plain(value)?;
    match key {
        "id" if value.is_empty() => Err("A mod needs an id.".into()),
        "id" if !value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_') =>
        {
            Err("Use lowercase letters, digits, '-' and '_' only.".into())
        }
        "name" if value.is_empty() => Err("A mod needs a name.".into()),
        "version" if !is_semver(value) => Err("Not a version like 1.2.3 (semver).".into()),
        "edition" if !value.is_empty() && !EDITIONS.contains(&value) => {
            Err(format!("Not a Rust edition ({}).", EDITIONS.join(", ")))
        }
        _ => Ok(()),
    }
}

/// `MAJOR.MINOR.PATCH`, optionally followed by `-pre`/`+build` — what Cargo
/// accepts for the crate `yog build` generates.
fn is_semver(value: &str) -> bool {
    let core = value.split(['-', '+']).next().unwrap_or("");
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        && (core.len() == value.len() || value.len() > core.len() + 1)
}

/// Gives a newly added key the same `key   =` padding the table's existing
/// keys use, so it lines up with them.
pub(crate) fn align_new_key(table: &mut Table, key: &str) {
    let width = table.iter().find_map(|(k, _)| {
        let suffix = table.key(k)?.leaf_decor().suffix()?.as_str()?;
        (suffix.len() > 1 && suffix.trim().is_empty()).then(|| k.len() + suffix.len())
    });
    if let (Some(width), Some(mut new_key)) = (width, table.key_mut(key)) {
        let pad = width.saturating_sub(key.len()).max(1);
        new_key.leaf_decor_mut().set_suffix(" ".repeat(pad));
    }
}

/// Sets one `[mod]` field (or `authors`) through `toml_edit`, so every
/// comment, blank line, key order and alignment in the file stays as it
/// was — only the edited value's text changes.
pub fn set_manifest_field(
    project_root: &Path,
    key: &str,
    value: FieldValue,
) -> Result<ManifestOut, String> {
    let path = manifest_path(project_root);
    let mut doc = load(&path)?;
    let new_value: Option<Value> = match (key, value) {
        ("authors", FieldValue::List(list)) => {
            let list: Vec<String> = list
                .iter()
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty())
                .collect();
            for author in &list {
                check_plain(author)?;
                if author.contains(',') {
                    return Err("An author's name can't contain a comma.".into());
                }
            }
            Some(Value::Array(list.into_iter().collect()))
        }
        (key, FieldValue::Text(text)) if TEXT_FIELDS.contains(&key) => {
            let text = text.trim().to_string();
            check_field(key, &text)?;
            if text.is_empty() && OPTIONAL_FIELDS.contains(&key) {
                None
            } else {
                Some(Value::from(text))
            }
        }
        _ => return Err(format!("'{key}' isn't an editable yog.toml field")),
    };

    let table = doc["mod"]
        .as_table_mut()
        .ok_or("yog.toml has no [mod] section")?;
    match new_value {
        None => {
            table.remove(key);
        }
        Some(mut value) => match table.get_mut(key) {
            // Replacing the item (not re-inserting the key) keeps the key's
            // own padding; the old value's surrounding whitespace carries over.
            Some(existing) => {
                if let Some(old) = existing.as_value() {
                    *value.decor_mut() = old.decor().clone();
                }
                *existing = Item::Value(value);
            }
            None => {
                table.insert(key, Item::Value(value));
                align_new_key(table, key);
            }
        },
    }
    std::fs::write(&path, doc.to_string()).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(summarize(&doc))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "# my mod\n[mod]\nid          = \"demo\"\nname        = \"Demo\"   # shown in-game\nversion     = \"0.1.0\"\nauthors     = [\"A\"]\n\n[dependencies]\nserde = \"*\"\n";

    fn project(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("yog-idle-props-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("yog.toml"), SAMPLE).unwrap();
        dir
    }

    #[test]
    fn edits_keep_formatting() {
        let dir = project("edit");
        set_manifest_field(&dir, "name", FieldValue::Text("Demo Mod".into())).unwrap();
        set_manifest_field(
            &dir,
            "authors",
            FieldValue::List(vec!["A".into(), " B ".into()]),
        )
        .unwrap();
        let out = set_manifest_field(&dir, "edition", FieldValue::Text("2024".into())).unwrap();
        let text = std::fs::read_to_string(dir.join("yog.toml")).unwrap();
        assert_eq!(
            text,
            "# my mod\n[mod]\nid          = \"demo\"\nname        = \"Demo Mod\"   # shown in-game\nversion     = \"0.1.0\"\nauthors     = [\"A\", \"B\"]\nedition     = \"2024\"\n\n[dependencies]\nserde = \"*\"\n"
        );
        assert_eq!(out.dependencies, 1);
        set_manifest_field(&dir, "edition", FieldValue::Text(String::new())).unwrap();
        assert!(
            !std::fs::read_to_string(dir.join("yog.toml"))
                .unwrap()
                .contains("edition")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_what_yog_cli_cannot_read() {
        let dir = project("reject");
        assert!(
            set_manifest_field(&dir, "description", FieldValue::Text("say \"hi\"".into())).is_err()
        );
        assert!(set_manifest_field(&dir, "version", FieldValue::Text("1.0".into())).is_err());
        assert!(set_manifest_field(&dir, "id", FieldValue::Text("Bad Id".into())).is_err());
        assert!(set_manifest_field(&dir, "dependencies", FieldValue::Text("x".into())).is_err());
        assert!(is_semver("1.2.3-beta.1") && !is_semver("1.2.3-"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
