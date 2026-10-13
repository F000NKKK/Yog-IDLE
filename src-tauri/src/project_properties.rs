//! Backend for Project Properties (Project > Properties, Alt+Enter on the
//! project): the whole of a mod's `yog.toml` as `yog-cli` reads it —
//! `[mod]`, `[dev]`, `[dependencies]`, `[dependencies.exports]` and every
//! `[run.<name>]` — edited in place through `toml_edit`, so comments, key
//! order and alignment survive. Plus the project's own build platforms
//! (`.yog-idle/settings.json`, the `YOG_TARGETS` a Build uses) and a
//! crates.io search for the Dependencies page.
//!
//! Every value must also survive `yog-cli`'s line-based reader: no quotes,
//! backslashes or line breaks, arrays on one line and no commas inside an
//! array item (it splits on them). `[run.forge-1.21.1]` is a dotted header
//! to TOML (run → forge-1 → 21 → 1) but one name to yog-cli; ids are
//! walked and written the dotted way, which prints the same header back.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use toml_edit::{Array, DocumentMut, InlineTable, Item, Table, Value};

use crate::properties::{self, FieldValue, check_plain};

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Dependency {
    pub name: String,
    /// Version requirement — empty with `path`/`git`.
    pub version: String,
    pub features: Vec<String>,
    pub default_features: bool,
    pub optional: bool,
    pub path: String,
    pub git: String,
    /// Keys of an inline-table spec this form doesn't edit (kept as written).
    pub other_keys: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RunTarget {
    /// The `<name>` of `[run.<name>]` — what `yog run <name>` takes.
    pub id: String,
    /// Display name (`name = "..."`).
    pub name: String,
    pub export_dir: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    /// `KEY=VALUE` entries.
    pub env: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProps {
    pub manifest: properties::ManifestOut,
    pub yog_api_version: Option<String>,
    pub dependencies: Vec<Dependency>,
    pub mod_dependencies: Vec<Dependency>,
    pub run_targets: Vec<RunTarget>,
    /// Platforms a Build of this project makes (empty: the Environment default).
    pub build_targets: Vec<String>,
}

const YOG_API_KEYS: &[&str] = &["yog-api", "yog_api", "yog_api_version"];

fn manifest(root: &Path) -> PathBuf {
    root.join("yog.toml")
}

fn str_list(item: Option<&Item>) -> Vec<String> {
    item.and_then(Item::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn dependency_of(name: &str, item: &Item) -> Option<Dependency> {
    let mut dep = Dependency {
        name: name.to_string(),
        default_features: true,
        ..Default::default()
    };
    match item.as_value()? {
        Value::String(s) => dep.version = s.value().clone(),
        Value::InlineTable(t) => {
            for (key, value) in t.iter() {
                match key {
                    "version" => dep.version = value.as_str().unwrap_or("").to_string(),
                    "path" => dep.path = value.as_str().unwrap_or("").to_string(),
                    "git" => dep.git = value.as_str().unwrap_or("").to_string(),
                    "features" => {
                        dep.features = value
                            .as_array()
                            .map(|a| {
                                a.iter()
                                    .filter_map(|v| v.as_str().map(str::to_string))
                                    .collect()
                            })
                            .unwrap_or_default()
                    }
                    "default-features" | "default_features" => {
                        dep.default_features = value.as_bool().unwrap_or(true)
                    }
                    "optional" => dep.optional = value.as_bool().unwrap_or(false),
                    other => dep.other_keys.push(other.to_string()),
                }
            }
        }
        _ => return None,
    }
    Some(dep)
}

fn dependencies_in(table: Option<&Item>) -> Vec<Dependency> {
    let Some(table) = table.and_then(Item::as_table_like) else {
        return Vec::new();
    };
    table
        .iter()
        // `[dependencies.exports]` lives inside `[dependencies]` as a real table.
        .filter(|(key, item)| !item.is_table() && !YOG_API_KEYS.contains(key))
        .filter_map(|(key, item)| dependency_of(key, item))
        .collect()
}

/// Every table under `[run]` with values of its own, by dotted id.
fn collect_run_targets(table: &Table, prefix: &str, out: &mut Vec<RunTarget>) {
    let has_values = table.iter().any(|(_, item)| item.is_value());
    if has_values && !prefix.is_empty() {
        let text = |key: &str| {
            table
                .get(key)
                .and_then(Item::as_str)
                .unwrap_or("")
                .to_string()
        };
        out.push(RunTarget {
            id: prefix.to_string(),
            name: text("name"),
            export_dir: text("export_dir"),
            command: text("command"),
            args: str_list(table.get("args")),
            cwd: text("cwd"),
            env: str_list(table.get("env")),
        });
    }
    for (key, item) in table.iter() {
        if let Some(child) = item.as_table() {
            let id = if prefix.is_empty() {
                key.to_string()
            } else {
                format!("{prefix}.{key}")
            };
            collect_run_targets(child, &id, out);
        }
    }
}

fn props_of(doc: &DocumentMut, root: &Path) -> ProjectProps {
    let mut run_targets = Vec::new();
    if let Some(run) = doc.get("run").and_then(Item::as_table) {
        collect_run_targets(run, "", &mut run_targets);
    }
    let deps = doc.get("dependencies");
    ProjectProps {
        manifest: properties::summarize(doc),
        yog_api_version: deps.and_then(Item::as_table_like).and_then(|t| {
            YOG_API_KEYS
                .iter()
                .find_map(|k| t.get(k).and_then(Item::as_str).map(str::to_string))
        }),
        dependencies: dependencies_in(deps),
        mod_dependencies: dependencies_in(deps.and_then(|d| d.get("exports"))),
        run_targets,
        build_targets: read_build_targets(root),
    }
}

fn write(path: &Path, doc: &DocumentMut) -> Result<(), String> {
    std::fs::write(path, doc.to_string()).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn read(root: &Path) -> Result<ProjectProps, String> {
    let doc = properties::load(&manifest(root))?;
    Ok(props_of(&doc, root))
}

/// Loads, edits, writes back, and returns the new state.
fn edit(
    root: &Path,
    change: impl FnOnce(&mut DocumentMut) -> Result<(), String>,
) -> Result<ProjectProps, String> {
    let path = manifest(root);
    let mut doc = properties::load(&path)?;
    change(&mut doc)?;
    write(&path, &doc)?;
    Ok(props_of(&doc, root))
}

/// A `[mod]` field or `authors` (see `properties::set_manifest_field`).
pub fn set_field(root: &Path, key: &str, value: FieldValue) -> Result<ProjectProps, String> {
    properties::set_manifest_field(root, key, value)?;
    read(root)
}

/// Replaces a value keeping its surrounding whitespace/comment, or inserts
/// it aligned with the table's other keys; `None` removes the key.
fn put(table: &mut Table, key: &str, value: Option<Value>) {
    match value {
        None => {
            table.remove(key);
        }
        Some(mut value) => match table.get_mut(key) {
            Some(existing) => {
                if let Some(old) = existing.as_value() {
                    *value.decor_mut() = old.decor().clone();
                }
                *existing = Item::Value(value);
            }
            None => {
                table.insert(key, Item::Value(value));
                properties::align_new_key(table, key);
            }
        },
    }
}

fn text_value(text: &str) -> Option<Value> {
    let text = text.trim();
    (!text.is_empty()).then(|| Value::from(text))
}

fn list_value(items: &[String]) -> Option<Value> {
    (!items.is_empty()).then(|| Value::Array(items.iter().map(String::as_str).collect::<Array>()))
}

fn table_mut<'a>(doc: &'a mut DocumentMut, key: &str) -> Result<&'a mut Table, String> {
    if doc.get(key).is_none() {
        doc.insert(key, Item::Table(Table::new()));
    }
    doc[key]
        .as_table_mut()
        .ok_or_else(|| format!("[{key}] isn't a table"))
}

/// `[dev] yog_api_path` — a local yog-api crate; empty removes it.
pub fn set_yog_api_path(root: &Path, value: &str) -> Result<ProjectProps, String> {
    check_plain(value)?;
    edit(root, |doc| {
        let value = text_value(value);
        if value.is_none() && doc.get("dev").is_none() {
            return Ok(());
        }
        let dev = table_mut(doc, "dev")?;
        put(dev, "yog_api_path", value);
        if dev.is_empty() {
            doc.remove("dev");
        }
        Ok(())
    })
}

/// The yog-api version pin in `[dependencies]`; empty: latest from crates.io.
pub fn set_yog_api_version(root: &Path, value: &str) -> Result<ProjectProps, String> {
    check_plain(value)?;
    edit(root, |doc| {
        let deps = table_mut(doc, "dependencies")?;
        let key = YOG_API_KEYS
            .iter()
            .find(|k| deps.contains_key(k))
            .copied()
            .unwrap_or("yog-api");
        put(deps, key, text_value(value));
        Ok(())
    })
}

fn check_name(name: &str, what: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(format!("A {what} needs a name."));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Use letters, digits, '-' and '_' only.".into());
    }
    Ok(())
}

/// An array item `yog-cli` can read back: plain, and no commas (it splits on them).
fn check_item(item: &str) -> Result<(), String> {
    check_plain(item)?;
    if item.contains(',') {
        return Err(format!(
            "\"{item}\": list items can't contain commas (yog splits on them)."
        ));
    }
    Ok(())
}

fn validate_dependency(dep: &Dependency) -> Result<(), String> {
    check_name(&dep.name, "dependency")?;
    for text in [&dep.version, &dep.path, &dep.git] {
        check_plain(text)?;
    }
    if dep.version.trim().is_empty() && dep.path.trim().is_empty() && dep.git.trim().is_empty() {
        return Err("Give a version (e.g. \"1.0\" or \"*\"), a path or a git URL.".into());
    }
    dep.features.iter().try_for_each(|f| check_item(f))
}

fn dependency_value(dep: &Dependency, existing: Option<&Item>) -> Value {
    let simple = dep.features.is_empty()
        && dep.default_features
        && !dep.optional
        && dep.path.trim().is_empty()
        && dep.git.trim().is_empty()
        && dep.other_keys.is_empty();
    let mut table = existing
        .and_then(Item::as_value)
        .and_then(Value::as_inline_table)
        .cloned()
        .unwrap_or_else(InlineTable::new);
    if simple && table.iter().all(|(k, _)| k == "version") {
        return Value::from(dep.version.trim());
    }
    let fields = [
        ("version", text_value(&dep.version)),
        ("path", text_value(&dep.path)),
        ("git", text_value(&dep.git)),
        ("features", list_value(&dep.features)),
        ("optional", dep.optional.then(|| Value::from(true))),
        ("default_features", None),
        (
            "default-features",
            (!dep.default_features).then(|| Value::from(false)),
        ),
    ];
    for (key, value) in fields {
        match value {
            Some(v) => {
                table.insert(key, v);
            }
            None => {
                table.remove(key);
            }
        }
    }
    table.fmt();
    Value::InlineTable(table)
}

/// The `[dependencies]` (`mods == false`) or `[dependencies.exports]` table.
fn dependency_table(doc: &mut DocumentMut, mods: bool) -> Result<&mut Table, String> {
    let deps = table_mut(doc, "dependencies")?;
    if !mods {
        return Ok(deps);
    }
    if deps.get("exports").is_none() {
        deps.insert("exports", Item::Table(Table::new()));
    }
    deps["exports"]
        .as_table_mut()
        .ok_or_else(|| "[dependencies.exports] isn't a table".to_string())
}

/// Adds or updates a dependency; `original` is its name before an edit (a rename).
pub fn set_dependency(
    root: &Path,
    mods: bool,
    original: Option<&str>,
    dep: &Dependency,
) -> Result<ProjectProps, String> {
    validate_dependency(dep)?;
    if YOG_API_KEYS.contains(&dep.name.as_str()) {
        return Err("Set the yog-api version on the Build page instead.".into());
    }
    edit(root, |doc| {
        let table = dependency_table(doc, mods)?;
        if original != Some(dep.name.as_str()) && table.contains_key(&dep.name) {
            return Err(format!("\"{}\" is already a dependency.", dep.name));
        }
        if let Some(original) = original.filter(|o| *o != dep.name) {
            table.remove(original);
        }
        let value = dependency_value(dep, table.get(&dep.name));
        put(table, &dep.name, Some(value));
        Ok(())
    })
}

pub fn remove_dependency(root: &Path, mods: bool, name: &str) -> Result<ProjectProps, String> {
    edit(root, |doc| {
        let table = dependency_table(doc, mods)?;
        table.remove(name);
        if mods && table.is_empty() {
            doc["dependencies"]
                .as_table_mut()
                .map(|d| d.remove("exports"));
        }
        Ok(())
    })
}

fn run_id_segments(id: &str) -> Result<Vec<&str>, String> {
    let segments: Vec<&str> = id.split('.').collect();
    if id.is_empty() || segments.iter().any(|s| s.is_empty()) {
        return Err("A run target needs an id, like fabric-1.21.1.".into());
    }
    for s in &segments {
        check_name(s, "run target")?;
    }
    Ok(segments)
}

fn validate_run_target(target: &RunTarget) -> Result<(), String> {
    run_id_segments(&target.id)?;
    for text in [
        &target.name,
        &target.export_dir,
        &target.command,
        &target.cwd,
    ] {
        check_plain(text)?;
    }
    target.args.iter().try_for_each(|a| check_item(a))?;
    for entry in &target.env {
        check_item(entry)?;
        match entry.split_once('=') {
            Some((key, _)) if !key.trim().is_empty() => {}
            _ => return Err(format!("\"{entry}\" isn't KEY=VALUE.")),
        }
    }
    Ok(())
}

/// The `[run.<id>]` table, created (with implicit parents) when missing.
fn run_table<'a>(doc: &'a mut DocumentMut, id: &str) -> Result<&'a mut Table, String> {
    let segments = run_id_segments(id)?;
    let mut table = table_mut(doc, "run")?;
    table.set_implicit(true);
    for (i, segment) in segments.iter().enumerate() {
        if table.get(segment).is_none() {
            let mut child = Table::new();
            child.set_implicit(i + 1 < segments.len());
            table.insert(segment, Item::Table(child));
        }
        table = table[segment]
            .as_table_mut()
            .ok_or_else(|| format!("run.{id} isn't a table"))?;
    }
    Ok(table)
}

/// Removes `[run.<id>]` (its values; sub-targets stay) and returns the old
/// table, pruning parents left empty.
fn take_run_table(doc: &mut DocumentMut, id: &str) -> Option<Table> {
    let segments = run_id_segments(id).ok()?;
    fn take(table: &mut Table, segments: &[&str]) -> Option<Table> {
        let (first, rest) = segments.split_first()?;
        if rest.is_empty() {
            let child = table.get_mut(first)?.as_table_mut()?;
            let has_children = child.iter().any(|(_, i)| i.is_table());
            if has_children {
                // Only this target's own values go; nested targets stay.
                let mut own = Table::new();
                let keys: Vec<String> = child
                    .iter()
                    .filter(|(_, i)| i.is_value())
                    .map(|(k, _)| k.to_string())
                    .collect();
                for key in keys {
                    if let Some(item) = child.remove(&key) {
                        own.insert(&key, item);
                    }
                }
                child.set_implicit(true);
                return Some(own);
            }
            return table.remove(first).and_then(|i| i.into_table().ok());
        }
        let child = table.get_mut(first)?.as_table_mut()?;
        let taken = take(child, rest);
        if child.is_empty() {
            table.remove(first);
        }
        taken
    }
    let run = doc.get_mut("run")?.as_table_mut()?;
    let taken = take(run, &segments);
    if run.is_empty() {
        doc.remove("run");
    }
    taken
}

const RUN_KEYS: &[&str] = &["name", "export_dir", "command", "args", "cwd", "env"];

/// Adds or updates `[run.<id>]`; `original` is its id before an edit (a rename).
pub fn set_run_target(
    root: &Path,
    original: Option<&str>,
    target: &RunTarget,
) -> Result<ProjectProps, String> {
    validate_run_target(target)?;
    edit(root, |doc| {
        let exists = |doc: &DocumentMut, id: &str| {
            let mut targets = Vec::new();
            if let Some(run) = doc.get("run").and_then(Item::as_table) {
                collect_run_targets(run, "", &mut targets);
            }
            targets.iter().any(|t| t.id == id)
        };
        if original != Some(target.id.as_str()) && exists(doc, &target.id) {
            return Err(format!("[run.{}] already exists.", target.id));
        }
        // A rename moves the table — same decor and place in the file.
        let moved = original
            .filter(|o| *o != target.id)
            .and_then(|o| take_run_table(doc, o));
        let is_new = moved.is_none() && !exists(doc, &target.id);
        let table = run_table(doc, &target.id)?;
        if let Some(moved) = moved {
            let position = moved.position();
            *table.decor_mut() = moved.decor().clone();
            for (key, item) in moved.into_iter() {
                table.insert(&key, item);
            }
            if let Some(position) = position {
                table.set_position(Some(position));
            }
        }
        table.set_implicit(false);
        let values = [
            text_value(&target.name),
            text_value(&target.export_dir),
            text_value(&target.command),
            list_value(&target.args),
            text_value(&target.cwd),
            list_value(&target.env),
        ];
        for (key, value) in RUN_KEYS.iter().zip(values) {
            put(table, key, value);
        }
        if is_new {
            // Line the keys up like the hand-written targets do.
            let width = table.iter().map(|(k, _)| k.len()).max().unwrap_or(0);
            let keys: Vec<String> = table.iter().map(|(k, _)| k.to_string()).collect();
            for key in keys {
                if let Some(mut k) = table.key_mut(&key) {
                    k.leaf_decor_mut()
                        .set_suffix(" ".repeat(width - key.len() + 1));
                }
            }
            table.decor_mut().set_prefix("\n");
        }
        Ok(())
    })
}

pub fn remove_run_target(root: &Path, id: &str) -> Result<ProjectProps, String> {
    edit(root, |doc| {
        take_run_table(doc, id).ok_or_else(|| format!("no [run.{id}] in yog.toml"))?;
        Ok(())
    })
}

// ── Project build platforms (.yog-idle/settings.json) ──────────────────────

fn settings_file(root: &Path) -> PathBuf {
    root.join(".yog-idle").join("settings.json")
}

pub fn read_build_targets(root: &Path) -> Vec<String> {
    std::fs::read_to_string(settings_file(root))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .map(|v| str_list_json(v.get("buildTargets")))
        .unwrap_or_default()
}

fn str_list_json(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub fn set_build_targets(root: &Path, targets: &[String]) -> Result<ProjectProps, String> {
    for t in targets {
        if !crate::environment::TARGETS.iter().any(|(tag, _)| tag == t) {
            return Err(format!("'{t}' isn't a platform yog builds for"));
        }
    }
    let file = settings_file(root);
    let mut value = std::fs::read_to_string(&file)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    value["buildTargets"] = serde_json::json!(targets);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        // Machine-local, like the workspace file next to it.
        let ignore = dir.join(".gitignore");
        if !ignore.exists() {
            let _ = std::fs::write(ignore, "*\n");
        }
    }
    let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    std::fs::write(&file, text).map_err(|e| e.to_string())?;
    read(root)
}

// ── crates.io search ────────────────────────────────────────────────────────

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CrateHit {
    /// The dependency key to use (a mod's id for `mods`).
    pub name: String,
    pub crate_name: String,
    pub version: String,
    pub description: String,
    pub downloads: u64,
}

fn url_encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// crates.io's `/api/v1/crates` response → hits. With `mods`, only the
/// `<id>_exports` crates `yog publish exports` makes, keyed by mod id.
pub fn parse_crates_response(json: &str, mods: bool) -> Vec<CrateHit> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    value["crates"]
        .as_array()
        .map(|crates| {
            crates
                .iter()
                .filter_map(|c| {
                    let crate_name = c["name"].as_str()?.to_string();
                    let name = if mods {
                        crate_name.strip_suffix("_exports")?.to_string()
                    } else {
                        crate_name.clone()
                    };
                    let version = c["max_stable_version"]
                        .as_str()
                        .or(c["max_version"].as_str())
                        .unwrap_or("")
                        .to_string();
                    Some(CrateHit {
                        name,
                        crate_name,
                        version,
                        description: c["description"].as_str().unwrap_or("").trim().to_string(),
                        downloads: c["downloads"].as_u64().unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn search_crates(query: &str, mods: bool) -> Result<Vec<CrateHit>, String> {
    let q = if mods {
        format!("{query} exports")
    } else {
        query.to_string()
    };
    let url = format!(
        "https://crates.io/api/v1/crates?q={}&per_page=25",
        url_encode(q.trim())
    );
    let out = std::process::Command::new("curl")
        .args([
            "-fsSL",
            "--max-time",
            "15",
            "-A",
            "Yog-IDLE (https://github.com/F000NKKK/Yog-IDLE)",
        ])
        .arg(&url)
        .output()
        .map_err(|e| format!("curl: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "crates.io search failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(parse_crates_response(
        &String::from_utf8_lossy(&out.stdout),
        mods,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
[mod]
id          = \"demo\"
name        = \"Demo\"
version     = \"0.1.0\"

# crates
[dependencies]
serde      = \"*\"
uuid = { version = \"1\", features = [\"v4\"] }

## `yog run <name>`
[run.forge-1.21.1]
name       = \"Forge 1.21.1\"
export_dir = \"../loader/forge/run/yog-mods\"
command    = \"./gradlew\"
args       = [\"runClient\", \"-Pminecraft_version=1.21.1\"]
cwd        = \"../loader/forge\"
env        = [\"JAVA_HOME=/usr/lib/jvm/java-21\"]
";

    fn project(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yog-idle-pp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("yog.toml"), SAMPLE).unwrap();
        dir
    }

    fn text(dir: &Path) -> String {
        std::fs::read_to_string(dir.join("yog.toml")).unwrap()
    }

    #[test]
    fn reads_the_whole_schema() {
        let dir = project("read");
        let props = read(&dir).unwrap();
        assert_eq!(props.dependencies.len(), 2);
        assert_eq!(props.dependencies[1].features, vec!["v4"]);
        assert_eq!(props.run_targets.len(), 1);
        let run = &props.run_targets[0];
        assert_eq!(run.id, "forge-1.21.1");
        assert_eq!(run.args, vec!["runClient", "-Pminecraft_version=1.21.1"]);
        assert_eq!(run.env, vec!["JAVA_HOME=/usr/lib/jvm/java-21"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn run_targets_round_trip_as_yog_reads_them() {
        let dir = project("run");
        let mut target = read(&dir).unwrap().run_targets.remove(0);
        target.args.push("--offline".into());
        set_run_target(&dir, Some("forge-1.21.1"), &target).unwrap();
        assert!(text(&dir).contains(
            "args       = [\"runClient\", \"-Pminecraft_version=1.21.1\", \"--offline\"]\n"
        ));

        let new = RunTarget {
            id: "fabric-1.20.1".into(),
            name: "Fabric 1.20.1".into(),
            command: "./gradlew".into(),
            args: vec!["runClient".into()],
            ..Default::default()
        };
        set_run_target(&dir, None, &new).unwrap();
        let out = text(&dir);
        assert!(
            out.ends_with("\n[run.fabric-1.20.1]\nname    = \"Fabric 1.20.1\"\ncommand = \"./gradlew\"\nargs    = [\"runClient\"]\n"),
            "{out}"
        );
        assert!(set_run_target(&dir, None, &new).is_err(), "duplicate id");

        // Rename keeps the table where it was.
        let renamed = RunTarget {
            id: "forge-1.21".into(),
            ..target.clone()
        };
        set_run_target(&dir, Some("forge-1.21.1"), &renamed).unwrap();
        let out = text(&dir);
        assert!(
            out.contains("## `yog run <name>`\n[run.forge-1.21]\nname "),
            "{out}"
        );
        assert!(!out.contains("[run.forge-1.21.1]"));

        remove_run_target(&dir, "forge-1.21").unwrap();
        remove_run_target(&dir, "fabric-1.20.1").unwrap();
        assert!(!text(&dir).contains("[run"));
        assert!(read(&dir).unwrap().run_targets.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_what_yog_cannot_read() {
        let dir = project("reject");
        let bad_arg = RunTarget {
            id: "x".into(),
            args: vec!["a,b".into()],
            ..Default::default()
        };
        assert!(set_run_target(&dir, None, &bad_arg).is_err());
        let bad_env = RunTarget {
            id: "x".into(),
            env: vec!["NOVALUE".into()],
            ..Default::default()
        };
        assert!(set_run_target(&dir, None, &bad_env).is_err());
        let bad_id = RunTarget {
            id: "a..b".into(),
            ..Default::default()
        };
        assert!(set_run_target(&dir, None, &bad_id).is_err());
        let quoted = RunTarget {
            id: "x".into(),
            command: "say \"hi\"".into(),
            ..Default::default()
        };
        assert!(set_run_target(&dir, None, &quoted).is_err());
        let no_version = Dependency {
            name: "rand".into(),
            default_features: true,
            ..Default::default()
        };
        assert!(set_dependency(&dir, false, None, &no_version).is_err());
        assert_eq!(text(&dir), SAMPLE);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn dependencies_edit_in_place() {
        let dir = project("deps");
        let mut uuid = read(&dir).unwrap().dependencies.remove(1);
        uuid.features.push("serde".into());
        set_dependency(&dir, false, Some("uuid"), &uuid).unwrap();
        assert!(
            text(&dir).contains("uuid = { version = \"1\", features = [\"v4\", \"serde\"] }\n")
        );

        let rand = Dependency {
            name: "rand".into(),
            version: "0.9".into(),
            default_features: true,
            ..Default::default()
        };
        set_dependency(&dir, false, None, &rand).unwrap();
        assert!(text(&dir).contains("rand       = \"0.9\"\n"));
        assert!(
            set_dependency(&dir, false, None, &rand).is_err(),
            "duplicate"
        );

        let pipes = Dependency {
            name: "yog-pipes".into(),
            version: "0.3".into(),
            default_features: true,
            ..Default::default()
        };
        let props = set_dependency(&dir, true, None, &pipes).unwrap();
        assert_eq!(props.mod_dependencies, vec![pipes.clone()]);
        assert!(text(&dir).contains("[dependencies.exports]\nyog-pipes = \"0.3\"\n"));
        let props = remove_dependency(&dir, true, "yog-pipes").unwrap();
        assert!(props.mod_dependencies.is_empty());
        assert!(!text(&dir).contains("exports"));

        set_yog_api_version(&dir, "0.9").unwrap();
        assert_eq!(read(&dir).unwrap().yog_api_version.as_deref(), Some("0.9"));
        assert_eq!(
            read(&dir).unwrap().dependencies.len(),
            3,
            "the pin isn't a dependency"
        );
        set_yog_api_version(&dir, "").unwrap();
        set_yog_api_path(&dir, "../yog-api").unwrap();
        assert!(text(&dir).contains("[dev]\nyog_api_path = \"../yog-api\"\n"));
        set_yog_api_path(&dir, "").unwrap();
        assert!(!text(&dir).contains("[dev]"));
        assert!(text(&dir).starts_with("[mod]\nid          = \"demo\"\n"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn build_targets_live_beside_the_workspace() {
        let dir = project("targets");
        assert!(read_build_targets(&dir).is_empty());
        set_build_targets(&dir, &["linux-x86_64".into()]).unwrap();
        assert_eq!(read(&dir).unwrap().build_targets, vec!["linux-x86_64"]);
        assert!(set_build_targets(&dir, &["amiga".into()]).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn parses_crates_io_search() {
        let json = r#"{"crates":[
            {"name":"yog_pipes_exports","max_stable_version":"0.3.2","max_version":"0.3.2","description":" Pipes ","downloads":12},
            {"name":"serde","max_stable_version":null,"max_version":"1.0.0-rc","description":"Ser","downloads":9}]}"#;
        let all = parse_crates_response(json, false);
        assert_eq!(all.len(), 2);
        assert_eq!(all[1].version, "1.0.0-rc");
        let mods = parse_crates_response(json, true);
        assert_eq!(mods.len(), 1);
        assert_eq!(mods[0].name, "yog_pipes");
        assert_eq!(mods[0].description, "Pipes");
        assert_eq!(url_encode("a b&c"), "a%20b%26c");
    }
}
