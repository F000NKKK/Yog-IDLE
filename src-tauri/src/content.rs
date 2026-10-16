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
        let doc = crate::data::read_object(&text)?;
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
    match texture_file(file, texture, "png") {
        Ok(bytes) => Ok(bytes),
        Err(original) => {
            let Some((x, y, w, h)) = brewing_sprite_sheet_region(texture) else {
                return Err(original);
            };
            let sheet = texture_file(file, "minecraft:gui/container/brewing_stand", "png")?;
            crop_png(&sheet, x, y, w, h).map_err(|e| format!("{original}; brewing sprite fallback: {e}"))
        }
    }
}

fn brewing_sprite_sheet_region(texture: &str) -> Option<(u32, u32, u32, u32)> {
    match texture {
        "minecraft:gui/sprites/container/brewing_stand/brew_progress" => Some((176, 0, 9, 28)),
        "minecraft:gui/sprites/container/brewing_stand/bubbles" => Some((185, 0, 12, 29)),
        "minecraft:gui/sprites/container/brewing_stand/fuel_length" => Some((176, 29, 18, 4)),
        _ => None,
    }
}

fn crop_png(bytes: &[u8], x: u32, y: u32, width: u32, height: u32) -> Result<Vec<u8>, String> {
    let image = crate::designer::assets::decode_png(bytes).ok_or("invalid PNG")?;
    if x + width > image.width || y + height > image.height {
        return Err(format!("crop {x},{y} {width}x{height} exceeds {}x{}", image.width, image.height));
    }
    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for row in y..y + height {
        let start = ((row * image.width + x) * 4) as usize;
        rgba.extend_from_slice(&image.rgba[start..start + (width * 4) as usize]);
    }
    let mut output = Vec::new();
    let mut encoder = png::Encoder::new(&mut output, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(&rgba).map_err(|e| e.to_string())?;
    drop(writer);
    Ok(output)
}

/// A file of texture `texture` — its `png`, or the `png.mcmeta` beside it —
/// from wherever the texture is: a `.yres` image, `resources/`, the mod's
/// assets or the Minecraft client jar.
fn texture_file(file: &Path, texture: &str, ext: &str) -> Result<Vec<u8>, String> {
    let root = mod_root(file);
    if let Some(r) = texture.strip_prefix('@') {
        let root = root.as_deref().ok_or("not in a mod")?;
        let png =
            yres_image(root, r).ok_or_else(|| format!("no image {texture} in resources/*.yres"))?;
        let p = png.with_extension(ext);
        return std::fs::read(&p).map_err(|e| format!("{}: {e}", p.display()));
    }
    if let Some(stem) = texture.strip_suffix(".png") {
        let root = root.as_deref().ok_or("not in a mod")?;
        let rel = stem
            .trim_start_matches("./")
            .trim_start_matches("resources/");
        if rel.split('/').any(|p| p == "..") {
            return Err("a path inside resources/".into());
        }
        let p = root.join("resources").join(format!("{rel}.{ext}"));
        return std::fs::read(&p).map_err(|_| format!("resources/{rel}.{ext} doesn't exist"));
    }
    let (ns, path) = split_id(texture);
    // A texture `yog build` bundles from `resources/` (`mymod:block/x` = `resources/block/x.png`).
    if let Some(root) = &root
        && mod_id(root).as_deref() == Some(ns)
        && let Ok(b) = std::fs::read(root.join("resources").join(format!("{path}.{ext}")))
    {
        return Ok(b);
    }
    Resources::for_mod(root.as_deref())
        .read(ns, &format!("textures/{path}.{ext}"))
        .ok_or_else(|| format!("texture {ns}:{path}.{ext} not found (mod assets/, resources/ or the Minecraft client jar)"))
}

/// The mod's `content/` file defining item or block `id` (`kind`:
/// `yitem` or `yblock`), parsed.
fn content_file(root: &Path, id: &str, kinds: &[&str]) -> Option<(PathBuf, Value)> {
    let ns = mod_id(root)?;
    let (want_ns, want) = split_id(id);
    if want_ns != ns {
        return None;
    }
    for kind in kinds {
        for file in find(&root.join("content"), kind) {
            let Some(doc) = std::fs::read_to_string(&file).ok().and_then(|t| crate::data::read_object(&t)).map(Value::Object) else {
                continue;
            };
            let fid = doc.get("id").and_then(Value::as_str).map(str::to_string)
                .or_else(|| file.file_stem().map(|s| s.to_string_lossy().into_owned()))?;
            if fid.split_once(':').map_or(fid.as_str(), |(_, p)| p) == want {
                return Some((file, doc));
            }
        }
    }
    None
}

/// The textures of the mod's block `id` (its `.yblock` model's), per face:
/// up, down, north, south, west, east — as png bytes. `None`: not a block
/// of the mod.
pub fn content_block_faces(root: &Path, id: &str) -> Option<[Option<Vec<u8>>; 6]> {
    let (file, doc) = content_file(root, id, &["yblock"])?;
    let textures = doc.pointer("/model/textures").and_then(Value::as_object)?;
    let pick = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| textures.get(*k).and_then(Value::as_str))
            .or_else(|| textures.values().find_map(Value::as_str))
            .and_then(|t| texture_bytes(&file, t).ok())
    };
    Some([
        pick(&["up", "top", "end", "all", "texture"]),
        pick(&["down", "bottom", "end", "all", "texture"]),
        pick(&["north", "front", "side", "all", "texture"]),
        pick(&["south", "side", "all", "texture"]),
        pick(&["west", "side", "all", "texture"]),
        pick(&["east", "side", "all", "texture"]),
    ])
}

/// The model of the mod's block `id` as its `.yblock` gives it: its
/// `elements` and its textures by variable (png bytes). `None`: not a
/// block of the mod, or its model has no elements of its own.
pub fn content_block_model(root: &Path, id: &str) -> Option<(Vec<Value>, std::collections::HashMap<String, Vec<u8>>)> {
    let (file, doc) = content_file(root, id, &["yblock"])?;
    let elements = match doc.pointer("/model/elements").and_then(Value::as_array) {
        Some(elements) => elements.clone(),
        None if doc.get("kind").and_then(Value::as_str) == Some("stairs") => vec![
            stair_element([0, 0, 0], [16, 8, 16]),
            stair_element([0, 8, 8], [16, 16, 16]),
        ],
        None => return None,
    };
    let textures = doc
        .pointer("/model/textures")
        .and_then(Value::as_object)
        .map(|t| t.iter().filter_map(|(k, v)| Some((k.clone(), texture_bytes(&file, v.as_str()?).ok()?))).collect())
        .unwrap_or_default();
    Some((elements, textures))
}

fn stair_element(from: [u8; 3], to: [u8; 3]) -> Value {
    let face = |texture: &str| serde_json::json!({ "texture": format!("#{texture}") });
    serde_json::json!({
        "from": from,
        "to": to,
        "faces": {
            "up": face("top"),
            "down": face("bottom"),
            "north": face("side"),
            "south": face("side"),
            "west": face("side"),
            "east": face("side")
        }
    })
}

/// A mod item's definition and, for potions, its effect-derived color.
pub fn content_item_appearance(root: &Path, id: &str) -> Option<(Value, Option<u32>)> {
    let ns = mod_id(root)?;
    let (want_ns, want) = split_id(id);
    if want_ns != ns {
        return None;
    }
    for file in find(&root.join("content/items"), "yitem") {
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        let Some(doc) = crate::data::read_object(&text) else {
            continue;
        };
        let Some(fid) = doc
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| file.file_stem().and_then(|s| s.to_str()))
        else {
            continue;
        };
        if fid.split_once(':').map_or(fid, |(_, p)| p) != want {
            continue;
        }
        let definition = Value::Object(doc);
        let color = potion_effect_color(root, &definition);
        return Some((definition, color));
    }
    None
}

fn potion_effect_color(root: &Path, item: &Value) -> Option<u32> {
    let effects = item.pointer("/item/potion/effects")?.as_array()?;
    let mut channels = [0u64; 3];
    let mut count = 0u64;
    for effect in effects {
        let Some(id) = effect.get("effect").and_then(Value::as_str) else {
            continue;
        };
        let Some(color) = content_effect_color(root, id) else {
            continue;
        };
        channels[0] += u64::from((color >> 16) & 0xFF);
        channels[1] += u64::from((color >> 8) & 0xFF);
        channels[2] += u64::from(color & 0xFF);
        count += 1;
    }
    (count > 0).then(|| {
        (((channels[0] / count) as u32) << 16)
            | (((channels[1] / count) as u32) << 8)
            | (channels[2] / count) as u32
    })
}

/// The color of the potion effect(s) defined by this `.yitem`.
pub fn item_potion_color(file: &Path) -> Option<u32> {
    let root = mod_root(file)?;
    let text = std::fs::read_to_string(file).ok()?;
    let item = Value::Object(crate::data::read_object(&text)?);
    potion_effect_color(&root, &item)
}

fn content_effect_color(root: &Path, reference: &str) -> Option<u32> {
    let mod_ns = mod_id(root)?;
    let id = reference.strip_prefix("@effect:").unwrap_or(reference);
    let (ns, want) = split_id(id);
    if ns != mod_ns {
        return None;
    }
    for file in find(&root.join("content/effects"), "ydef") {
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        let Some(doc) = crate::data::read_object(&text) else {
            continue;
        };
        let Some(id) = doc
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| file.file_stem().and_then(|s| s.to_str()))
        else {
            continue;
        };
        if id.split_once(':').map_or(id, |(_, p)| p) == want {
            return doc
                .get("color")
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok());
        }
    }
    None
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
        let Some(doc) = crate::data::read_object(&text).map(Value::Object) else { continue };
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
    /// Its `.png.mcmeta` animation, if it has one.
    pub animation: Option<Animation>,
    /// The texture is the mod's own file — the editor can paint it in place
    /// (otherwise painting copies it into the mod first).
    pub writable: bool,
}

/// A texture's animation (`.png.mcmeta`), as the game plays it: frames
/// `frame_width`×`frame_height` laid row by row over the image, shown in
/// `frames` order, each for its `time` in ticks.
#[derive(Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Animation {
    pub frame_width: u32,
    pub frame_height: u32,
    pub frames: Vec<AnimationFrame>,
    /// Blends each frame into the next (the game's `interpolate`).
    pub interpolate: bool,
}

#[derive(Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct AnimationFrame {
    pub index: u32,
    /// Ticks (1/20 s).
    pub time: u32,
}

impl Animation {
    /// The animation of a `size` image from its `.mcmeta` text; `None` when it has none.
    pub fn read(meta: &str, (w, h): (u32, u32)) -> Option<Animation> {
        let doc: Value = serde_json::from_str(meta).ok()?;
        let a = doc.get("animation")?;
        let num = |k: &str| a.get(k).and_then(Value::as_u64).map(|n| n as u32);
        // The game's default frame: square, the image's smaller side.
        let side = w.min(h);
        let fw = num("width").unwrap_or(side).max(1);
        let fh = num("height").unwrap_or(side).max(1);
        let count = (w / fw) * (h / fh);
        if count == 0 {
            return None;
        }
        let frametime = num("frametime").unwrap_or(1).max(1);
        let frames = match a.get("frames").and_then(Value::as_array) {
            Some(list) => list
                .iter()
                .filter_map(|f| match f {
                    Value::Number(n) => Some(AnimationFrame { index: n.as_u64()? as u32, time: frametime }),
                    Value::Object(o) => Some(AnimationFrame {
                        index: o.get("index")?.as_u64()? as u32,
                        time: o.get("time").and_then(Value::as_u64).map_or(frametime, |t| (t as u32).max(1)),
                    }),
                    _ => None,
                })
                .filter(|f| f.index < count)
                .collect(),
            None => (0..count).map(|index| AnimationFrame { index, time: frametime }).collect(),
        };
        Some(Animation {
            frame_width: fw,
            frame_height: fh,
            frames,
            interpolate: a.get("interpolate").and_then(Value::as_bool).unwrap_or(false),
        })
    }

    /// The `.mcmeta` text for it — every frame listed with its time.
    pub fn write(&self, (w, h): (u32, u32)) -> String {
        let mut a = serde_json::Map::new();
        if self.interpolate {
            a.insert("interpolate".into(), Value::Bool(true));
        }
        let side = w.min(h);
        if self.frame_width != side {
            a.insert("width".into(), self.frame_width.into());
        }
        if self.frame_height != side {
            a.insert("height".into(), self.frame_height.into());
        }
        let frames = self.frames.iter().map(|f| serde_json::json!({ "index": f.index, "time": f.time })).collect();
        a.insert("frames".into(), Value::Array(frames));
        let mut text = serde_json::to_string_pretty(&serde_json::json!({ "animation": a })).unwrap_or_default();
        text.push('\n');
        text
    }
}

/// Writes `animation` as texture `texture`'s `.png.mcmeta` (beside the png
/// `texture_target` names), or removes it for `None`.
pub fn write_animation(file: &Path, texture: &str, animation: Option<&Animation>) -> Result<PathBuf, String> {
    let png = texture_target(file, texture).ok_or_else(|| format!("{texture} isn't a texture of this mod"))?;
    let meta = png.with_extension("png.mcmeta");
    match animation {
        Some(a) => {
            let size = std::fs::read(&png).ok().and_then(|b| image_size(&b)).ok_or_else(|| format!("{} isn't a png", png.display()))?;
            std::fs::write(&meta, a.write(size)).map_err(|e| format!("{}: {e}", meta.display()))?;
        }
        None => {
            if meta.exists() {
                std::fs::remove_file(&meta).map_err(|e| format!("{}: {e}", meta.display()))?;
            }
        }
    }
    Ok(meta)
}

/// A body model's texture (`.ymodel`): a path under the mod's `textures/`
/// (`entity/wisp.png`) or a full id (`minecraft:textures/entity/elytra.png`).
pub fn body_texture(file: &Path, texture: &str) -> Result<Texture, String> {
    let id = match texture.split_once(':') {
        Some((ns, p)) => format!("{ns}:{}", p.trim_start_matches("textures/").trim_end_matches(".png")),
        None => {
            let ns = mod_root(file).and_then(|r| mod_id(&r)).unwrap_or_else(|| "minecraft".into());
            format!("{ns}:{}", texture.trim_start_matches('/').trim_end_matches(".png"))
        }
    };
    self::texture(file, &id)
}

pub fn texture(file: &Path, texture: &str) -> Result<Texture, String> {
    let bytes = texture_bytes(file, texture)?;
    let animation = image_size(&bytes).and_then(|size| {
        let meta = texture_file(file, texture, "png.mcmeta").ok()?;
        Animation::read(&String::from_utf8_lossy(&meta), size)
    });
    Ok(Texture {
        url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        ),
        animation,
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
        let Some(doc) = crate::data::read_object(&text) else {
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

/// What a `.ydef` reference offers: the game's built-ins by short name,
/// then the mod's own definitions of `kind` as `@<kind>:` refs.
fn definitions(file: &Path, kind: &str, built_ins: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = built_ins.into_iter().map(|id| id.trim_start_matches("minecraft:").to_string()).collect();
    let Some(root) = mod_root(file) else {
        return out;
    };
    let ns = mod_id(&root).unwrap_or_else(|| "minecraft".into());
    let mut own = Vec::new();
    for p in find(&root.join("content"), "ydef") {
        let Some(doc) = std::fs::read_to_string(&p).ok().and_then(|t| crate::data::read_object(&t)) else {
            continue;
        };
        if doc.get("kind").and_then(Value::as_str) != Some(kind) {
            continue;
        }
        if let Some(id) = doc.get("id").and_then(Value::as_str) {
            own.push(format!("@{kind}:{}", if id.contains(':') { id.to_string() } else { format!("{ns}:{id}") }));
        }
    }
    own.sort();
    out.extend(own);
    out
}

/// What a block's `sound` offers: the game's sound groups, then the mod's.
pub fn sound_groups(file: &Path) -> Vec<String> {
    definitions(file, "sound_group", yog_formats::def::SoundGroup::built_ins().iter().map(|g| g.id.clone()))
}

/// What a tool's `material` offers: the game's, then the mod's.
pub fn tool_materials(file: &Path) -> Vec<String> {
    definitions(file, "tool_material", yog_formats::def::ToolMaterial::built_ins().iter().map(|m| m.id.clone()))
}

/// What an armor piece's `material` offers: the game's, then the mod's.
pub fn armor_materials(file: &Path) -> Vec<String> {
    definitions(file, "armor_material", yog_formats::def::ArmorMaterial::built_ins().iter().map(|m| m.id.clone()))
}

/// What a `tags` list of content in `registry` (`item`, `block`) offers:
/// the mod's own tags by bare name (as the build last listed them), then
/// Yog's common tags.
pub fn tags(file: &Path, registry: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(root) = mod_root(file) {
        let ns = mod_id(&root).unwrap_or_default();
        let listed = std::fs::read(root.join(".yog-build/generated/tags.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<std::collections::BTreeMap<String, std::collections::BTreeMap<String, Value>>>(&b).ok())
            .and_then(|mut by| by.remove(registry))
            .unwrap_or_default();
        out.extend(listed.into_keys().filter_map(|t| t.strip_prefix(&format!("{ns}:")).map(str::to_string)));
    }
    out.extend(yog_formats::tags::yog_tags(registry).into_iter().map(|(p, _)| format!("yog:{p}")));
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
            let Some(doc) = crate::data::read_object(&text) else {
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
    #[test]
    fn animation_reads_the_games_mcmeta() {
        let meta = r#"{"animation":{"frametime":3,"frames":[0,{"index":2,"time":10},7]}}"#;
        let a = Animation::read(meta, (16, 64)).unwrap();
        assert_eq!((a.frame_width, a.frame_height), (16, 16));
        // Frame 7 is past the four the image holds.
        assert_eq!(a.frames, vec![AnimationFrame { index: 0, time: 3 }, AnimationFrame { index: 2, time: 10 }]);
        assert!(!a.interpolate);
        let all = Animation::read(r#"{"animation":{}}"#, (16, 48)).unwrap();
        assert_eq!(all.frames.iter().map(|f| f.index).collect::<Vec<_>>(), vec![0, 1, 2]);
        assert!(Animation::read("{}", (16, 16)).is_none());
    }

    #[test]
    fn animation_round_trips() {
        let a = Animation { frame_width: 16, frame_height: 16, frames: vec![AnimationFrame { index: 1, time: 4 }, AnimationFrame { index: 0, time: 1 }], interpolate: true };
        assert_eq!(Animation::read(&a.write((16, 32)), (16, 32)), Some(a));
    }

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
    fn sound_groups_are_the_games_then_the_mods() {
        let dir = std::env::temp_dir().join(format!("idle-sounds-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("content")).unwrap();
        std::fs::write(dir.join("yog.toml"), "[mod]\nid = \"mymod\"\n").unwrap();
        std::fs::write(dir.join("content/crystal.ydef"), r#"{ kind: "sound_group", id: "crystal" }"#).unwrap();
        std::fs::write(dir.join("content/mythril.ydef"), r#"{ kind: "level", id: "mythril" }"#).unwrap();
        let all = sound_groups(&dir.join("content/ore.yblock"));
        assert!(all.contains(&"stone".to_string()) && all.contains(&"amethyst".to_string()));
        assert_eq!(all.last().map(String::as_str), Some("@sound_group:mymod:crystal"));
        assert!(!all.iter().any(|s| s.contains("mythril")));
        let _ = std::fs::remove_dir_all(&dir);
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

    #[test]
    fn item_appearance_reads_its_model_and_effect_colors() {
        let dir = std::env::temp_dir().join(format!("idle-item-appearance-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("content/items")).unwrap();
        std::fs::create_dir_all(dir.join("content/effects")).unwrap();
        std::fs::write(dir.join("yog.toml"), "[mod]\nid = \"mymod\"\n").unwrap();
        std::fs::write(
            dir.join("content/items/potion.yitem"),
            r#"{ model: { parent: "minecraft:item/potion" }, item: { potion: { effects: [{ effect: "@effect:mymod:glow" }] } } }"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("content/effects/glow.ydef"),
            r#"{ kind: "effect", id: "glow", color: 1193046 }"#,
        )
        .unwrap();

        let (definition, color) = content_item_appearance(&dir, "mymod:potion").unwrap();
        assert_eq!(
            definition.pointer("/model/parent").and_then(Value::as_str),
            Some("minecraft:item/potion")
        );
        assert_eq!(color, Some(0x123456));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn stairs_without_custom_elements_get_a_step_shape() {
        let dir = std::env::temp_dir().join(format!("idle-stairs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("content/blocks")).unwrap();
        std::fs::write(dir.join("yog.toml"), "[mod]\nid = \"mymod\"\n").unwrap();
        std::fs::write(
            dir.join("content/blocks/stairs.yblock"),
            r#"{ kind: "stairs", model: { textures: { top: "block/top.png", bottom: "block/bottom.png", side: "block/side.png" } } }"#,
        )
        .unwrap();

        let (elements, _) = content_block_model(&dir, "mymod:stairs").unwrap();
        assert_eq!(elements.len(), 2);
        assert_eq!(elements[0]["from"], serde_json::json!([0, 0, 0]));
        assert_eq!(elements[0]["to"], serde_json::json!([16, 8, 16]));
        assert_eq!(elements[1]["from"], serde_json::json!([0, 8, 8]));
        assert_eq!(elements[1]["to"], serde_json::json!([16, 16, 16]));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
