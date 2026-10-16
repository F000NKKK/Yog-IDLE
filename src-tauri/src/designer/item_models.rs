//! Items as the game's item models show them in a GUI, for what plain
//! textures don't cover: layered models (with their tints — spawn eggs,
//! potions, leather) and `builtin/entity` heads, drawn as a 3D head.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;

use super::assets::{Image, Resources, decode_png, split_id};
use super::blocks3d::Faces;

/// How an item looks in a slot.
pub enum Look {
    /// A flat picture: its model's layers.
    Flat(Arc<Image>),
    /// A mob's head (skulls): a cube with these faces.
    Head(Faces),
}

/// `id`'s look from its item model; `None` when it has no model this
/// understands (callers then guess its texture by name).
pub fn look(res: &Resources, id: &str) -> Option<Look> {
    let (ns, path) = split_id(id);
    let (parents, textures) = model_chain(res, &format!("{ns}:item/{path}"));
    let is = |p: &str| parents.iter().any(|x| split_id(x).1 == p);
    if (is("item/template_skull") || is("builtin/entity"))
        && let Some(tex) = HEADS.iter().find(|(name, _)| *name == path).map(|(_, t)| *t)
    {
        return head(res, tex).map(Look::Head);
    }
    let mut layers = Vec::new();
    for i in 0.. {
        let Some(t) = textures.get(&format!("layer{i}")) else { break };
        layers.push(t.clone());
    }
    if layers.is_empty() {
        return None;
    }
    // The tints the game's item colors give each layer.
    let tints: Vec<Option<u32>> = if is("item/template_spawn_egg") {
        let (a, b) = EGGS.iter().find(|(n, ..)| path.strip_suffix("_spawn_egg") == Some(n)).map(|(_, a, b)| (*a, *b))?;
        vec![Some(a), Some(b)]
    } else {
        match path {
            "potion" | "splash_potion" | "lingering_potion" | "tipped_arrow" => vec![Some(WATER)],
            p if p.starts_with("leather_") => vec![Some(LEATHER)],
            _ => Vec::new(),
        }
    };
    let mut out: Option<Image> = None;
    for (i, layer) in layers.iter().enumerate() {
        let (lns, lpath) = split_id(layer);
        let Some(img) = res.read(lns, &format!("textures/{lpath}.png")).and_then(|b| decode_png(&b)) else { continue };
        let img = first_frame(img);
        let tint = tints.get(i).copied().flatten();
        match &mut out {
            None => out = Some(tinted(img, tint)),
            Some(base) if base.width == img.width && base.height == img.height => over(base, &tinted(img, tint)),
            Some(_) => {}
        }
    }
    out.map(|i| Look::Flat(Arc::new(i)))
}

/// A model's parents (itself first) and its textures, the child's winning.
fn model_chain(res: &Resources, model: &str) -> (Vec<String>, HashMap<String, String>) {
    let mut chain = Vec::new();
    let mut textures = HashMap::new();
    let mut at = model.to_string();
    for _ in 0..8 {
        chain.push(at.clone());
        let (ns, path) = split_id(&at);
        let Some(json) = res.read(ns, &format!("models/{path}.json")).and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        else {
            break;
        };
        if let Some(t) = json.get("textures").and_then(Value::as_object) {
            for (k, v) in t {
                if let Some(v) = v.as_str() {
                    textures.entry(k.clone()).or_insert_with(|| v.to_string());
                }
            }
        }
        match json.get("parent").and_then(Value::as_str) {
            Some(p) => at = p.to_string(),
            None => break,
        }
    }
    (chain, textures)
}

/// An animated texture's first frame (square, at the top).
fn first_frame(img: Image) -> Image {
    if img.height <= img.width {
        return img;
    }
    crop(&img, 0, 0, img.width, img.width)
}

fn crop(img: &Image, x: u32, y: u32, w: u32, h: u32) -> Image {
    let mut rgba = Vec::with_capacity((w * h * 4) as usize);
    for yy in y..(y + h).min(img.height) {
        for xx in x..(x + w).min(img.width) {
            rgba.extend_from_slice(&img.pixel(xx, yy).to_rgba8());
        }
    }
    let w = w.min(img.width.saturating_sub(x));
    let h = h.min(img.height.saturating_sub(y));
    Image { width: w, height: h, rgba }
}

/// `img` with its colors multiplied by `tint` (`0xRRGGBB`).
fn tinted(mut img: Image, tint: Option<u32>) -> Image {
    if let Some(t) = tint {
        let m = [(t >> 16) & 0xFF, (t >> 8) & 0xFF, t & 0xFF];
        for px in img.rgba.chunks_exact_mut(4) {
            for c in 0..3 {
                px[c] = (px[c] as u32 * m[c] / 255) as u8;
            }
        }
    }
    img
}

/// `top` drawn over `base` (alpha blended).
fn over(base: &mut Image, top: &Image) {
    for (b, t) in base.rgba.chunks_exact_mut(4).zip(top.rgba.chunks_exact(4)) {
        let a = t[3] as u32;
        for c in 0..3 {
            b[c] = ((t[c] as u32 * a + b[c] as u32 * (255 - a)) / 255) as u8;
        }
        b[3] = (a + b[3] as u32 * (255 - a) / 255).min(255) as u8;
    }
}

/// A head's faces from its mob's texture (the head cube's UVs, 8 px at 64 wide).
fn head(res: &Resources, tex: &str) -> Option<Faces> {
    let (ns, path) = split_id(tex);
    let img = decode_png(&res.read(ns, &format!("textures/{path}.png"))?)?;
    let u = img.width / 64;
    let f = |x: u32, y: u32| Some(Arc::new(crop(&img, x * u, y * u, 8 * u, 8 * u)));
    // up, down, north (the face), south, west, east
    Some([f(8, 0), f(16, 0), f(8, 8), f(24, 8), f(16, 8), f(0, 8)])
}

/// Items drawn as their mob's head.
const HEADS: &[(&str, &str)] = &[
    ("skeleton_skull", "minecraft:entity/skeleton/skeleton"),
    ("wither_skeleton_skull", "minecraft:entity/skeleton/wither_skeleton"),
    ("zombie_head", "minecraft:entity/zombie/zombie"),
    ("creeper_head", "minecraft:entity/creeper/creeper"),
    ("piglin_head", "minecraft:entity/piglin/piglin"),
    ("player_head", "minecraft:entity/player/wide/steve"),
];

/// A water bottle's color (potions without effects).
const WATER: u32 = 0x385DC6;
/// Undyed leather's color.
const LEATHER: u32 = 0xA06540;

/// Spawn eggs' colors (`SpawnEggItem`: base, spots), 1.20.1–1.21.1.
const EGGS: &[(&str, u32, u32)] = &[
    ("allay", 0x00DAFF, 0x00ADFF),
    ("armadillo", 0xAD716D, 0x824848),
    ("axolotl", 0xFBC1E3, 0xA62D74),
    ("bat", 0x4C3E30, 0x0F0F0F),
    ("bee", 0xEDC343, 0x43241B),
    ("blaze", 0xF6B201, 0xFFF87E),
    ("bogged", 0x8A9C72, 0x314D1B),
    ("breeze", 0xAF94DF, 0x9166DF),
    ("camel", 0xFCC369, 0xCB9337),
    ("cat", 0xEFC88E, 0x957256),
    ("cave_spider", 0x0C424E, 0xA80E0E),
    ("chicken", 0xA1A1A1, 0xFF0000),
    ("cod", 0xC1A76A, 0xE5C48B),
    ("cow", 0x443626, 0xA1A1A1),
    ("creeper", 0x0DA70B, 0x000000),
    ("dolphin", 0x223B4D, 0xF9F9F9),
    ("donkey", 0x534539, 0x867566),
    ("drowned", 0x8FF1D7, 0x799C65),
    ("elder_guardian", 0xCECCBA, 0x747693),
    ("ender_dragon", 0x1C1C1C, 0xE079FA),
    ("enderman", 0x161616, 0x000000),
    ("endermite", 0x161616, 0x6E6E6E),
    ("evoker", 0x959B9B, 0x1E1C1A),
    ("fox", 0xD5B69F, 0xCC6920),
    ("frog", 0xD07444, 0xFFC77C),
    ("ghast", 0xF9F9F9, 0xBCBCBC),
    ("glow_squid", 0x095656, 0x85F1BC),
    ("goat", 0xA5947C, 0x55493E),
    ("guardian", 0x5A8272, 0xF17D30),
    ("hoglin", 0xC66E55, 0x5F6464),
    ("horse", 0xC09E7D, 0xEEE500),
    ("husk", 0x797061, 0xE6CC94),
    ("iron_golem", 0xDBCDC2, 0x74A332),
    ("llama", 0xC09E7D, 0x995F40),
    ("magma_cube", 0x340000, 0xFCFC00),
    ("mooshroom", 0xA00F10, 0xB7B7B7),
    ("mule", 0x1B0200, 0x51331D),
    ("ocelot", 0xEFDE7D, 0x564434),
    ("panda", 0xE7E7E7, 0x1B1B22),
    ("parrot", 0x0DA70B, 0xFF0000),
    ("phantom", 0x43518A, 0x88FF00),
    ("piglin_brute", 0x592A10, 0xF9F3A4),
    ("piglin", 0x995F40, 0xF9F3A4),
    ("pig", 0xF0A5A2, 0xDB635F),
    ("pillager", 0x532F36, 0x959B9B),
    ("polar_bear", 0xEEEEDE, 0xD5D6CD),
    ("pufferfish", 0xF6B201, 0x37C3F2),
    ("rabbit", 0x995F40, 0x734831),
    ("ravager", 0x757470, 0x5B5049),
    ("salmon", 0xA00F10, 0x0E8474),
    ("sheep", 0xE7E7E7, 0xFFB5B5),
    ("shulker", 0x946794, 0x4D3852),
    ("silverfish", 0x6E6E6E, 0x303030),
    ("skeleton_horse", 0x68684F, 0xE5E5D8),
    ("skeleton", 0xC1C1C1, 0x494949),
    ("slime", 0x51A03E, 0x7EBF6E),
    ("sniffer", 0x871E09, 0x25AB70),
    ("snow_golem", 0xD9F2F2, 0x81A4A4),
    ("spider", 0x342D27, 0xA80E0E),
    ("squid", 0x223B4D, 0x708899),
    ("stray", 0x617677, 0xDDEAEA),
    ("strider", 0x9C3436, 0x4D494D),
    ("tadpole", 0x6D533D, 0x160A00),
    ("trader_llama", 0xEAA430, 0x456296),
    ("tropical_fish", 0xEF6915, 0xFFF9EF),
    ("turtle", 0xE7E7E7, 0x00AFAF),
    ("vex", 0x7A90A4, 0xE8EDF1),
    ("villager", 0x563C33, 0xBD8B72),
    ("vindicator", 0x959B9B, 0x275E61),
    ("wandering_trader", 0x456296, 0xEAA430),
    ("warden", 0x0F4649, 0x39D6E0),
    ("witch", 0x340000, 0x51A03E),
    ("wither_skeleton", 0x141414, 0x474D4D),
    ("wither", 0x141414, 0x4D72A0),
    ("wolf", 0xD7D3D3, 0xCEAF96),
    ("zoglin", 0xC66E55, 0xE6E6E6),
    ("zombie_horse", 0x315234, 0x97C284),
    ("zombie", 0x00AFAF, 0x799C65),
    ("zombie_villager", 0x563C33, 0x799C65),
    ("zombified_piglin", 0xEA9393, 0x4C7129),
];
