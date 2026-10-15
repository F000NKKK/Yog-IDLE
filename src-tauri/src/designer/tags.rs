//! What an item tag holds (`#minecraft:planks`), for slots that show each
//! of its items in turn, as JEI does: the mod's own `data/<ns>/tags/…` and
//! the game's (from the client jar), nested tags opened.

use std::collections::BTreeSet;
use std::path::Path;

use serde_json::Value;

use super::assets::{Resources, split_id};

/// The tag files' folders: `item` since 1.21, `items` before.
const DIRS: [&str; 2] = ["item", "items"];

fn tag_file(res: &Resources, root: Option<&Path>, ns: &str, path: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for dir in DIRS {
        let rel = format!("{ns}/tags/{dir}/{path}.json");
        if let Some(root) = root {
            for base in [root.join("data"), root.join("src/data"), root.join("resources/data")] {
                if let Some(v) = std::fs::read(base.join(&rel)).ok().and_then(|b| serde_json::from_slice(&b).ok()) {
                    out.push(v);
                }
            }
        }
        if let Some(v) = res.vanilla.as_ref().and_then(|v| v.read_data(&rel)).and_then(|b| serde_json::from_slice(&b).ok()) {
            out.push(v);
        }
    }
    out
}

fn collect(res: &Resources, root: Option<&Path>, tag: &str, seen: &mut BTreeSet<String>, out: &mut Vec<String>, depth: usize) {
    if depth > 16 || !seen.insert(tag.to_owned()) {
        return;
    }
    let (ns, path) = split_id(tag);
    for file in tag_file(res, root, ns, path) {
        for v in file.get("values").and_then(Value::as_array).into_iter().flatten() {
            // `"id"` or `{ "id": …, "required": false }`.
            let Some(id) = v.as_str().or_else(|| v.get("id").and_then(Value::as_str)) else { continue };
            match id.strip_prefix('#') {
                Some(inner) => collect(res, root, inner, seen, out, depth + 1),
                None => {
                    let full = if id.contains(':') { id.to_owned() } else { format!("minecraft:{id}") };
                    if !out.contains(&full) {
                        out.push(full);
                    }
                }
            }
        }
    }
}

/// The items of tag `tag` (`minecraft:planks`, no `#`), for the mod the
/// file at `path` belongs to; empty if the tag is unknown.
pub fn item_tag(path: &Path, tag: &str) -> Vec<String> {
    let root = super::mod_root(path);
    let res = Resources::for_mod(root.as_deref());
    let mut out = Vec::new();
    collect(&res, root.as_deref(), tag.trim_start_matches('#'), &mut BTreeSet::new(), &mut out, 0);
    out
}
