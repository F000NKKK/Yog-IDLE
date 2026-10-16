//! What an item tag holds (`#minecraft:planks`), for slots that show each
//! of its items in turn, as JEI does: the mod's own tags as `yog build`
//! makes them (its `.yog-build/generated/tags.json` — content files'
//! `tags`, `.ydef` tags), and the game's — from the newest version that has
//! the tag (one removed in 1.21 still shows its 1.20 items) — nested tags
//! opened. Yog's common tags (`yog:ingots/iron`) are the game's and the
//! loaders' tags they stand for, and a loader's (`c:`, `forge:`) holds what
//! `yog_formats::tags` says.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::assets::{split_id, vanilla_versions};

/// The tags shown: item tags.
const REGISTRY: &str = "item";

/// The tag files' folders: `item` since 1.21, `items` before.
const DIRS: [&str; 2] = ["item", "items"];

/// The mod's item tags, as the CLI listed them (`yog content check` / `yog build`).
fn mod_tags(root: Option<&Path>) -> BTreeMap<String, Vec<String>> {
    let Some(root) = root else { return BTreeMap::new() };
    let mut tags = std::fs::read(root.join(".yog-build/generated/tags.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<BTreeMap<String, BTreeMap<String, Vec<String>>>>(&b).ok())
        .and_then(|mut kinds| kinds.remove("item"))
        .unwrap_or_default();
    let Some(ns) = crate::manifest::read_mod_field(root, "id") else { return tags };
    for ext in ["yblock", "yitem", "ydef"] {
        for file in source_files(&root.join("content"), ext) {
            let Ok(text) = std::fs::read_to_string(&file) else { continue };
            let Some(doc) = crate::data::read_object(&text) else { continue };
            let value = Value::Object(doc);
            if ext == "ydef" {
                if value.get("kind").and_then(Value::as_str) != Some("tag") || value.get("of").and_then(Value::as_str) != Some("item") {
                    continue;
                }
                let Some(raw_id) = value.get("id").and_then(Value::as_str) else { continue };
                let tag = qualify(&ns, raw_id);
                let entries = tags.entry(tag).or_default();
                for values in ["values", "optional"].into_iter().filter_map(|k| value.get(k).and_then(Value::as_array)) {
                    for entry in values.iter().filter_map(Value::as_str).map(|v| tag_entry(&ns, v)) {
                        if !entries.contains(&entry) {
                            entries.push(entry);
                        }
                    }
                }
            } else {
                let Some(raw_id) = value.get("id").and_then(Value::as_str).or_else(|| file.file_stem().and_then(|s| s.to_str())) else { continue };
                let item_id = qualify(&ns, raw_id);
                for raw_tag in value.get("tags").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                    let entries = tags.entry(qualify(&ns, raw_tag.trim_start_matches('#'))).or_default();
                    if !entries.contains(&item_id) {
                        entries.push(item_id.clone());
                    }
                }
            }
        }
    }
    tags
}

fn source_files(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().is_some_and(|e| e == ext) {
                out.push(path);
            }
        }
    }
    out
}

fn qualify(ns: &str, id: &str) -> String {
    if id.contains(':') { id.to_owned() } else { format!("{ns}:{id}") }
}

fn tag_entry(ns: &str, value: &str) -> String {
    let tag = value.strip_prefix("@tag:item:").or_else(|| value.strip_prefix("@tag:block:"));
    if let Some(tag) = tag {
        return format!("#{}", qualify(ns, tag));
    }
    if let Some(tag) = value.strip_prefix('#') {
        return format!("#{}", qualify(ns, tag));
    }
    value
        .strip_prefix("@item:")
        .or_else(|| value.strip_prefix("@block:"))
        .map_or_else(|| qualify(ns, value), |id| qualify(ns, id))
}

/// Tag `tag`'s entries: the mod's, then the game's from the newest version with it.
fn entries(roots: &[PathBuf], own: &BTreeMap<String, Vec<String>>, tag: &str) -> Vec<String> {
    let mut out = own.get(tag).cloned().unwrap_or_default();
    let (ns, path) = split_id(tag);
    if ns == "yog"
        && let Some(of) = yog_formats::tags::yog_tag(REGISTRY, path)
    {
        out.extend(of.iter().map(|t| format!("#{t}")));
        return out;
    }
    if let Some(has) = yog_formats::tags::loader_tag(REGISTRY, tag) {
        out.extend(has.iter().cloned());
        return out;
    }
    'versions: for v in vanilla_versions(roots) {
        for dir in DIRS {
            let rel = format!("{ns}/tags/{dir}/{path}.json");
            let Some(file) = v.read_data(&rel).and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { continue };
            for e in file.get("values").and_then(Value::as_array).into_iter().flatten() {
                // `"id"` or `{ "id": …, "required": false }`.
                if let Some(id) = e.as_str().or_else(|| e.get("id").and_then(Value::as_str)) {
                    out.push(id.to_owned());
                }
            }
            break 'versions;
        }
    }
    out
}

fn collect(roots: &[PathBuf], own: &BTreeMap<String, Vec<String>>, tag: &str, seen: &mut BTreeSet<String>, out: &mut Vec<String>, depth: usize) {
    if depth > 16 || !seen.insert(tag.to_owned()) {
        return;
    }
    for id in entries(roots, own, tag) {
        match id.strip_prefix('#') {
            Some(inner) => collect(roots, own, inner, seen, out, depth + 1),
            None => {
                let full = if id.contains(':') { id } else { format!("minecraft:{id}") };
                if !out.contains(&full) {
                    out.push(full);
                }
            }
        }
    }
}

/// The items of tag `tag` (`minecraft:planks`, no `#`), for the mod the
/// file at `path` belongs to; empty if the tag is unknown.
pub fn item_tag(path: &Path, tag: &str) -> Vec<String> {
    let root = super::mod_root(path);
    let roots: Vec<PathBuf> = root.iter().flat_map(|r| [r.clone(), r.parent().map(Path::to_path_buf).unwrap_or_default()]).collect();
    let own = mod_tags(root.as_deref());
    let mut out = Vec::new();
    let tag = tag.trim_start_matches('#');
    let full = if tag.contains(':') { tag.to_owned() } else { format!("minecraft:{tag}") };
    collect(&roots, &own, &full, &mut BTreeSet::new(), &mut out, 0);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yog_tags_open_into_the_tags_they_stand_for() {
        let items = item_tag(Path::new("/nowhere/r.yrecipe"), "#yog:ingots/iron");
        assert!(items.iter().any(|i| i == "minecraft:iron_ingot"), "{items:?}");
    }
}
