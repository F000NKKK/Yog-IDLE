//! The block/item model editor's backend (`.yblock` / `.yitem`, see
//! `docs/blocks-items.md`): textures as the editor names them, the
//! texture picker's list, vanilla/parent models for preview, and
//! `yog import`.

use crate::designer::assets::{Resources, split_id};
use crate::manifest::{self, mod_root};
use base64::Engine as _;
use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

/// `[mod] id` of the mod at `root`.
fn mod_id(root: &Path) -> Option<String> {
    manifest::read_mod_field(root, "id")
}

/// A `.yres` image entry `@<Set>.<name>` → its png file.
fn yres_image(root: &Path, reference: &str) -> Option<PathBuf> {
    let (set, name) = reference.split_once('.')?;
    for file in find(&root.join("resources"), "yres") {
        if file.file_stem().and_then(|s| s.to_str()) != Some(set) {
            continue;
        }
        let text = std::fs::read_to_string(&file).ok()?;
        let doc: Map<String, Value> = serde_json::from_str(&text).ok()?;
        let entry = doc.get(name)?;
        if entry.get("type").and_then(Value::as_str) != Some("image") {
            return None;
        }
        let value = entry.get("value")?.as_str()?;
        return Some(file.parent()?.join(value));
    }
    None
}

fn find(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|x| x == ext) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// The png bytes of a texture as a content file names it: `@Set.name`,
/// `path.png` (in `resources/`), or a texture id (`ns:block/x`).
fn texture_bytes(file: &Path, texture: &str) -> Result<Vec<u8>, String> {
    let root = mod_root(file);
    if let Some(r) = texture.strip_prefix('@') {
        let root = root.as_deref().ok_or("not in a mod")?;
        let png =
            yres_image(root, r).ok_or_else(|| format!("no image {texture} in resources/*.yres"))?;
        return std::fs::read(&png).map_err(|e| format!("{}: {e}", png.display()));
    }
    if let Some(stem) = texture.strip_suffix(".png") {
        let root = root.as_deref().ok_or("not in a mod")?;
        let rel = stem
            .trim_start_matches("./")
            .trim_start_matches("resources/");
        if rel.split('/').any(|p| p == "..") {
            return Err("a path inside resources/".into());
        }
        let p = root.join("resources").join(format!("{rel}.png"));
        return std::fs::read(&p).map_err(|_| format!("resources/{rel}.png doesn't exist"));
    }
    let (ns, path) = split_id(texture);
    // A texture `yog build` bundles from `resources/` (`mymod:block/x` = `resources/block/x.png`).
    if let Some(root) = &root
        && mod_id(root).as_deref() == Some(ns)
        && let Ok(b) = std::fs::read(root.join("resources").join(format!("{path}.png")))
    {
        return Ok(b);
    }
    Resources::for_mod(root.as_deref())
        .read(ns, &format!("textures/{path}.png"))
        .ok_or_else(|| format!("texture {ns}:{path} not found (mod assets/, resources/ or the Minecraft client jar)"))
}

/// The icon of the mod's item or block `id` as its `content/` file draws
/// it: the model's `layer0` (else its first texture), as png bytes.
pub fn content_icon(root: &Path, id: &str) -> Option<Vec<u8>> {
    let ns = mod_id(root)?;
    let (want_ns, want) = split_id(id);
    if want_ns != ns {
        return None;
    }
    let files = [find(&root.join("content"), "yitem"), find(&root.join("content"), "yblock")].concat();
    for file in files {
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        let Ok(doc) = serde_json::from_str::<Value>(&text) else { continue };
        let fid = doc.get("id").and_then(Value::as_str).map(str::to_string)
            .or_else(|| file.file_stem().map(|s| s.to_string_lossy().into_owned()))?;
        let fid = fid.split_once(':').map_or(fid.as_str(), |(_, p)| p).to_string();
        if fid != want {
            continue;
        }
        let textures = doc.pointer("/model/textures").and_then(Value::as_object)?;
        let tex = textures
            .get("layer0")
            .or_else(|| ["all", "side", "top", "texture"].iter().find_map(|k| textures.get(*k)))
            .or_else(|| textures.values().next())?
            .as_str()?;
        return texture_bytes(&file, tex).ok();
    }
    None
}

#[derive(Serialize)]
pub struct Texture {
    /// `data:image/png;base64,...`
    pub url: String,
    /// `.mcmeta` animation: frames are stacked, each `width` tall.
    pub animated: bool,
    /// The texture is the mod's own file — the editor can paint it in place
    /// (otherwise painting copies it into the mod first).
    pub writable: bool,
}

pub fn texture(file: &Path, texture: &str) -> Result<Texture, String> {
    let bytes = texture_bytes(file, texture)?;
    let animated = image_size(&bytes).is_some_and(|(w, h)| h > w && h % w == 0);
    Ok(Texture {
        url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        ),
        animated,
        writable: texture_target(file, texture).is_some(),
    })
}

/// A relative path with no `..`, root or drive parts.
fn plain_relative(rel: &str) -> bool {
    !rel.is_empty()
        && Path::new(rel)
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
}

/// Where a texture of the mod is written: a `.yres` image's png, a png
/// under `resources/` (created if missing), or the mod's own `ns:path`
/// (`resources/<path>.png`, or `assets/<ns>/textures/<path>.png` when only
/// that exists). `None`: not the mod's (vanilla, another mod's, `#slot`).
pub fn texture_target(file: &Path, texture: &str) -> Option<PathBuf> {
    let root = mod_root(file)?;
    if let Some(r) = texture.strip_prefix('@') {
        let png = yres_image(&root, r)?;
        let rel = png.strip_prefix(&root).ok()?.to_string_lossy().into_owned();
        return plain_relative(&rel).then_some(png);
    }
    if texture.ends_with(".png") {
        let rel = texture
            .trim_start_matches("./")
            .trim_start_matches("resources/");
        return plain_relative(rel).then(|| root.join("resources").join(rel));
    }
    if texture.starts_with('#') {
        return None;
    }
    let (ns, path) = split_id(texture);
    if mod_id(&root).as_deref() != Some(ns) || !plain_relative(path) {
        return None;
    }
    let resources = root.join("resources").join(format!("{path}.png"));
    let assets = root
        .join("assets")
        .join(ns)
        .join("textures")
        .join(format!("{path}.png"));
    Some(if !resources.is_file() && assets.is_file() {
        assets
    } else {
        resources
    })
}

/// Writes `png` (PNG bytes) to `target` (from `texture_target`), creating
/// its folder.
pub fn write_png(target: &Path, png: &[u8]) -> Result<(), String> {
    if image_size(png).is_none() {
        return Err("not a PNG image".into());
    }
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    std::fs::write(target, png).map_err(|e| format!("{}: {e}", target.display()))
}

/// Width and height from a PNG header.
fn image_size(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() < 24 || &png[1..4] != b"PNG" {
        return None;
    }
    let w = u32::from_be_bytes(png[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(png[20..24].try_into().ok()?);
    Some((w, h))
}

#[derive(Serialize)]
pub struct TextureChoice {
    /// What goes in the content file.
    pub value: String,
    /// "Resources", "Resource sets", "Mod assets", "Minecraft blocks", "Minecraft items".
    pub group: &'static str,
}

/// The `@<Set>.<name>` texts of the mod's `.yres` files — the name/tooltip picker's choices.
pub fn strings(file: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let Some(root) = mod_root(file) else {
        return out;
    };
    for p in find(&root.join("resources"), "yres") {
        let Some(set) = p.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if set.contains('.') {
            continue; // a culture variant
        }
        let Ok(text) = std::fs::read_to_string(&p) else {
            continue;
        };
        let Ok(doc) = serde_json::from_str::<Map<String, Value>>(&text) else {
            continue;
        };
        for (name, e) in &doc {
            let ty = e.get("type").and_then(Value::as_str);
            if e.is_string() || ty.is_none_or(|t| t == "string") {
                out.push(format!("@{set}.{name}"));
            }
        }
    }
    out.sort();
    out
}

/// Everything the texture picker offers.
pub fn textures(file: &Path) -> Vec<TextureChoice> {
    let mut out = Vec::new();
    let root = mod_root(file);
    if let Some(root) = &root {
        let res = root.join("resources");
        for p in find(&res, "yres") {
            let Some(set) = p.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if set.contains('.') {
                continue; // a culture variant
            }
            let Ok(text) = std::fs::read_to_string(&p) else {
                continue;
            };
            let Ok(doc) = serde_json::from_str::<Map<String, Value>>(&text) else {
                continue;
            };
            for (name, e) in &doc {
                if e.get("type").and_then(Value::as_str) == Some("image") {
                    out.push(TextureChoice {
                        value: format!("@{set}.{name}"),
                        group: "Resource sets",
                    });
                }
            }
        }
        for p in find(&res, "png") {
            if let Ok(rel) = p.strip_prefix(&res) {
                out.push(TextureChoice {
                    value: rel.to_string_lossy().replace('\\', "/"),
                    group: "Resources",
                });
            }
        }
        let assets = root.join("assets");
        for p in find(&assets, "png") {
            let Ok(rel) = p.strip_prefix(&assets) else {
                continue;
            };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if let Some((ns, rest)) = rel.split_once("/textures/")
                && !ns.contains('/')
            {
                out.push(TextureChoice {
                    value: format!("{ns}:{}", rest.trim_end_matches(".png")),
                    group: "Mod assets",
                });
            }
        }
    }
    if let Some(v) = Resources::for_mod(root.as_deref()).vanilla {
        let (items, blocks) = v.texture_names();
        out.extend(blocks.into_iter().map(|b| TextureChoice {
            value: format!("minecraft:block/{b}"),
            group: "Minecraft blocks",
        }));
        out.extend(items.into_iter().map(|i| TextureChoice {
            value: format!("minecraft:item/{i}"),
            group: "Minecraft items",
        }));
    }
    out
}

/// A model by id, parents flattened: `{textures, elements?, display, parent?}`
/// where `parent` is the vanilla sprite/builtin root it ends at, if any.
pub fn parent_model(file: &Path, id: &str) -> Result<Value, String> {
    let resources = Resources::for_mod(mod_root(file).as_deref());
    let mut textures = Map::new();
    let mut display = Map::new();
    let mut elements: Option<Value> = None;
    let mut current = id.to_string();
    let mut root_parent: Option<String> = None;
    for _ in 0..16 {
        let (ns, path) = split_id(&current);
        let bytes = resources
            .read(ns, &format!("models/{path}.json"))
            .ok_or_else(|| format!("model {ns}:{path} not found"))?;
        let m: Map<String, Value> =
            serde_json::from_slice(&bytes).map_err(|e| format!("{ns}:{path}: {e}"))?;
        if let Some(Value::Object(t)) = m.get("textures") {
            for (k, v) in t {
                textures.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
        if let Some(Value::Object(d)) = m.get("display") {
            for (k, v) in d {
                display.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
        if elements.is_none() {
            elements = m.get("elements").cloned();
        }
        match m.get("parent").and_then(Value::as_str) {
            None => break,
            Some(p) if p.contains("builtin/") => {
                root_parent = Some(p.to_string());
                break;
            }
            Some(p) => {
                let full = if p.contains(':') {
                    p.to_string()
                } else {
                    format!("minecraft:{p}")
                };
                if full == "minecraft:item/generated" || full == "minecraft:item/handheld" {
                    root_parent = Some(full.clone());
                }
                current = full;
            }
        }
    }
    let mut out = Map::new();
    out.insert("textures".into(), Value::Object(textures));
    out.insert("display".into(), Value::Object(display));
    if let Some(e) = elements {
        out.insert("elements".into(), e);
    }
    if let Some(p) = root_parent {
        out.insert("parent".into(), Value::String(p));
    }
    Ok(Value::Object(out))
}

/// `yog import <kind> <source> [--model <id>] [--force]` (`kind`: `resourcepack`,
/// `bbmodel`, or `bbmodel-item`) in the mod of
/// `file` (a content file or the mod folder) → what it printed.
pub fn import(
    file: &Path,
    kind: &str,
    source: &str,
    model: Option<&str>,
    force: bool,
) -> Result<String, String> {
    let root = mod_root(file).ok_or("not in a mod (no yog.toml)")?;
    // `bbmodel-item`: a Blockbench model as an item.
    let (what, item) = match kind {
        "resourcepack" => ("resourcepack", false),
        "bbmodel" => ("bbmodel", false),
        "bbmodel-item" => ("bbmodel", true),
        _ => return Err(format!("unknown import kind {kind}")),
    };
    let mut cmd = Command::new("yog");
    cmd.current_dir(&root).args(["import", what, source]);
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        cmd.args([if what == "bbmodel" { "--id" } else { "--model" }, m]);
    } else if what == "resourcepack" {
        cmd.arg("--all");
    }
    if item {
        cmd.arg("--item");
    }
    if force {
        cmd.arg("--force");
    }
    let out = cmd
        .output()
        .map_err(|e| format!("failed to run yog: {e}"))?;
    let text = String::from_utf8_lossy(&out.stderr).replace("yog: error: ", "");
    if out.status.success() {
        Ok(text.trim().to_string())
    } else {
        Err(text.trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_size() {
        let mut png = vec![
            0x89, b'P', b'N', b'G', 13, 10, 26, 10, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
        ];
        png.extend(16u32.to_be_bytes());
        png.extend(64u32.to_be_bytes());
        assert_eq!(image_size(&png), Some((16, 64)));
    }

    #[test]
    fn resolves_yres_images_and_resource_paths() {
        let dir = std::env::temp_dir().join(format!("idle-content-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("resources/block")).unwrap();
        std::fs::create_dir_all(dir.join("content")).unwrap();
        std::fs::write(dir.join("yog.toml"), "[mod]\nid = \"mymod\"\n").unwrap();
        std::fs::write(dir.join("resources/block/ruby.png"), b"png!").unwrap();
        std::fs::write(
            dir.join("resources/Textures.yres"),
            r#"{ "ruby": { "type": "image", "value": "block/ruby.png" } }"#,
        )
        .unwrap();
        let file = dir.join("content/ruby.yblock");
        assert_eq!(texture_bytes(&file, "@Textures.ruby").unwrap(), b"png!");
        assert_eq!(texture_bytes(&file, "block/ruby.png").unwrap(), b"png!");
        assert_eq!(texture_bytes(&file, "mymod:block/ruby").unwrap(), b"png!");
        let choices = textures(&file);
        assert!(choices.iter().any(|c| c.value == "@Textures.ruby"));
        assert!(choices.iter().any(|c| c.value == "block/ruby.png"));
        assert_eq!(mod_id(&dir).as_deref(), Some("mymod"));
        assert_eq!(
            texture_target(&file, "@Textures.ruby"),
            Some(dir.join("resources/block/ruby.png"))
        );
        assert_eq!(
            texture_target(&file, "item/new.png"),
            Some(dir.join("resources/item/new.png"))
        );
        assert_eq!(
            texture_target(&file, "mymod:item/new"),
            Some(dir.join("resources/item/new.png"))
        );
        assert_eq!(texture_target(&file, "../escape.png"), None);
        assert_eq!(texture_target(&file, "/etc/x.png"), None);
        assert_eq!(texture_target(&file, "minecraft:item/apple"), None);
        assert_eq!(texture_target(&file, "#layer0"), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
