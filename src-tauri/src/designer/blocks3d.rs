//! `draw2d_blocks` in the designer: blocks in 3D, as the game draws them in
//! a GUI (an orthographic view, turned and tilted), each block a cube with
//! its model's boxes (`elements`: a cable's core, a slab's half) with
//! their textures — the faces you'd see, back to front, the top lit, the
//! sides shaded like Minecraft's. A model without elements is a cube;
//! elements' rotations are left out.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde_json::Value;

use super::assets::{Image, Resources, decode_png, split_id};
use super::raster::Canvas;

/// A cube's textures per face: up, down, north, south, west, east.
pub type Faces = [Option<Arc<Image>>; 6];

/// One box of a model, in sixteenths of a block: per face (up, down,
/// north, south, west, east) its texture, already cut to the face's uv
/// (`None`: the box has no such face).
#[derive(Clone)]
pub struct Cuboid {
    pub from: [f32; 3],
    pub to: [f32; 3],
    pub faces: Faces,
}

/// A block as drawn: its model's boxes.
pub type Shape = Vec<Cuboid>;

/// A whole-block cube with `faces` (a missing one: the missing texture).
pub fn cube(faces: Faces) -> Shape {
    let faces = faces.map(|f| Some(f.unwrap_or_else(|| Arc::new(Image::missing()))));
    vec![Cuboid { from: [0.0; 3], to: [16.0; 3], faces }]
}

const FACE_NAMES: [&str; 6] = ["up", "down", "north", "south", "west", "east"];

/// The part of a face's texture its box shows when the model gives no `uv`.
fn default_uv(slot: usize, f: [f32; 3], t: [f32; 3]) -> [f32; 4] {
    match slot {
        0 => [f[0], f[2], t[0], t[2]],
        1 => [f[0], 16.0 - t[2], t[0], 16.0 - f[2]],
        2 => [16.0 - t[0], 16.0 - t[1], 16.0 - f[0], 16.0 - f[1]],
        3 => [f[0], 16.0 - t[1], t[0], 16.0 - f[1]],
        4 => [f[2], 16.0 - t[1], t[2], 16.0 - f[1]],
        _ => [16.0 - t[2], 16.0 - t[1], 16.0 - f[2], 16.0 - f[1]],
    }
}

/// `img`'s part `uv` (sixteenths of it; reversed: mirrored).
fn cut(img: &Image, [u0, v0, u1, v1]: [f32; 4]) -> Image {
    let (sx, sy) = (img.w as f32 / 16.0, img.w.min(img.h) as f32 / 16.0);
    let (x0, x1) = ((u0 * sx).round() as i32, (u1 * sx).round() as i32);
    let (y0, y1) = ((v0 * sy).round() as i32, (v1 * sy).round() as i32);
    let (w, h) = ((x1 - x0).unsigned_abs().max(1), (y1 - y0).unsigned_abs().max(1));
    let mut rgba = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h as i32 {
        for x in 0..w as i32 {
            let px = if x1 >= x0 { x0 + x } else { x0 - 1 - x };
            let py = if y1 >= y0 { y0 + y } else { y0 - 1 - y };
            let (px, py) = (px.clamp(0, img.w as i32 - 1) as u32, py.clamp(0, img.h as i32 - 1) as u32);
            rgba.extend_from_slice(&img.pixel(px, py));
        }
    }
    Image { w, h, rgba }
}

/// A model's `elements` as boxes; `texture("#var" or "var")` gives a face's texture.
pub fn shape_of(elements: &[Value], texture: &mut dyn FnMut(&str) -> Option<Arc<Image>>) -> Shape {
    let triple = |v: Option<&Value>| -> Option<[f32; 3]> {
        let a = v?.as_array()?;
        Some([a.first()?.as_f64()? as f32, a.get(1)?.as_f64()? as f32, a.get(2)?.as_f64()? as f32])
    };
    elements
        .iter()
        .filter_map(|e| {
            let (from, to) = (triple(e.get("from"))?, triple(e.get("to"))?);
            let (f, t) = ([0, 1, 2].map(|i| from[i].min(to[i])), [0, 1, 2].map(|i| from[i].max(to[i])));
            let faces = e.get("faces")?;
            let faces: Faces = std::array::from_fn(|slot| {
                let face = faces.get(FACE_NAMES[slot])?;
                let img = face.get("texture").and_then(Value::as_str).and_then(&mut *texture).unwrap_or_else(|| Arc::new(Image::missing()));
                let uv = face
                    .get("uv")
                    .and_then(Value::as_array)
                    .and_then(|a| Some([a.first()?.as_f64()? as f32, a.get(1)?.as_f64()? as f32, a.get(2)?.as_f64()? as f32, a.get(3)?.as_f64()? as f32]))
                    .unwrap_or_else(|| default_uv(slot, f, t));
                Some(Arc::new(cut(&img, uv)))
            });
            Some(Cuboid { from: f, to: t, faces })
        })
        .collect()
}

/// The first `elements` up a model's parents.
fn model_elements(res: &Resources, model: &str, depth: usize) -> Option<Vec<Value>> {
    if depth > 8 {
        return None;
    }
    let (ns, path) = split_id(model);
    let path = path.strip_prefix("block/").map_or(format!("block/{path}"), |p| format!("block/{p}"));
    let json: Value = serde_json::from_slice(&res.read(ns, &format!("models/{path}.json"))?).ok()?;
    if let Some(e) = json.get("elements").and_then(Value::as_array) {
        return Some(e.clone());
    }
    model_elements(res, json.get("parent")?.as_str()?, depth + 1)
}

/// The texture variables of a block model, its parents' included.
fn model_textures(res: &Resources, model: &str, depth: usize) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if depth > 8 {
        return out;
    }
    let (ns, path) = split_id(model);
    let path = path.strip_prefix("block/").map_or(format!("block/{path}"), |p| format!("block/{p}"));
    let Some(json) = res.read(ns, &format!("models/{path}.json")).and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else {
        return out;
    };
    if let Some(parent) = json.get("parent").and_then(Value::as_str) {
        out = model_textures(res, parent, depth + 1);
    }
    if let Some(t) = json.get("textures").and_then(Value::as_object) {
        for (k, v) in t {
            if let Some(v) = v.as_str() {
                out.insert(k.clone(), v.to_string());
            }
        }
    }
    out
}

/// The model a block's blockstate shows first (its first variant or part).
fn block_model(res: &Resources, id: &str) -> Option<String> {
    let (ns, path) = split_id(id);
    let json: Value = serde_json::from_slice(&res.read(ns, &format!("blockstates/{path}.json"))?).ok()?;
    let first = |v: &Value| -> Option<String> {
        let v = if v.is_array() { v.get(0)? } else { v };
        v.get("model")?.as_str().map(str::to_string)
    };
    if let Some(variants) = json.get("variants").and_then(Value::as_object) {
        return variants.values().find_map(first);
    }
    json.get("multipart")?.as_array()?.iter().find_map(|p| first(p.get("apply")?))
}

/// Whether `id` is a block (the game's, or the mod's `.yblock`).
pub fn is_block(res: &Resources, id: &str) -> bool {
    let (ns, path) = split_id(id);
    res.read(ns, &format!("blockstates/{path}.json")).is_some()
        || res.mod_root.as_deref().is_some_and(|root| crate::content::content_block_faces(root, id).is_some())
}

fn shape(res: &Resources, id: &str, cache: &mut HashMap<String, Shape>) -> Shape {
    if let Some(s) = cache.get(id) {
        return s.clone();
    }
    // The mod's own block: its `.yblock` model — its elements, else a cube of its textures.
    if let Some(root) = res.mod_root.as_deref() {
        if let Some((elements, textures)) = crate::content::content_block_model(root, id) {
            let mut decoded: HashMap<String, Option<Arc<Image>>> = HashMap::new();
            let mut texture = |var: &str| -> Option<Arc<Image>> {
                let var = var.trim_start_matches('#');
                decoded.entry(var.to_string()).or_insert_with(|| textures.get(var).and_then(|b| decode_png(b)).map(Arc::new)).clone()
            };
            let s = shape_of(&elements, &mut texture);
            if !s.is_empty() {
                cache.insert(id.to_string(), s.clone());
                return s;
            }
        }
        if let Some(faces) = crate::content::content_block_faces(root, id) {
            let s = cube(faces.map(|b| b.and_then(|b| decode_png(&b)).map(Arc::new)));
            cache.insert(id.to_string(), s.clone());
            return s;
        }
    }
    let model = block_model(res, id).unwrap_or_else(|| {
        let (ns, path) = split_id(id);
        format!("{ns}:block/{path}")
    });
    let vars = model_textures(res, &model, 0);
    // `#var` → its value, following references.
    let resolve = |key: &str| -> Option<String> {
        let mut v = vars.get(key)?.clone();
        for _ in 0..8 {
            match v.strip_prefix('#') {
                Some(r) => v = vars.get(r)?.clone(),
                None => return Some(v),
            }
        }
        None
    };
    let pick = |keys: &[&str]| keys.iter().find_map(|k| resolve(k));
    let load = |tex: Option<String>| -> Option<Arc<Image>> {
        let tex = tex?;
        let (ns, path) = split_id(&tex);
        decode_png(&res.read(ns, &format!("textures/{path}.png"))?).map(Arc::new)
    };
    if let Some(elements) = model_elements(res, &model, 0) {
        let mut texture = |var: &str| load(resolve(var.trim_start_matches('#')));
        let s = shape_of(&elements, &mut texture);
        if !s.is_empty() {
            cache.insert(id.to_string(), s.clone());
            return s;
        }
    }
    let f: Faces = [
        load(pick(&["up", "top", "end", "all", "texture", "particle"])),
        load(pick(&["down", "bottom", "end", "all", "texture", "particle"])),
        load(pick(&["north", "front", "side", "all", "texture", "particle"])),
        load(pick(&["south", "side", "all", "texture", "particle"])),
        load(pick(&["west", "side", "all", "texture", "particle"])),
        load(pick(&["east", "side", "all", "texture", "particle"])),
    ];
    let s = cube(f);
    cache.insert(id.to_string(), s.clone());
    s
}

/// `x y z state` lines → blocks.
fn parse(list: &str) -> Vec<([i32; 3], String)> {
    list.lines()
        .filter_map(|l| {
            let mut p = l.trim().splitn(4, ' ');
            let at = [p.next()?.parse().ok()?, p.next()?.parse().ok()?, p.next()?.parse().ok()?];
            let state = p.next()?;
            let id = state.split('[').next().unwrap_or(state).to_string();
            Some((at, id))
        })
        .collect()
}

pub fn draw(c: &mut Canvas, list: &str, rect: [f32; 4], yaw: f32, pitch: f32) {
    let mut cache = HashMap::new();
    draw_with(c, &parse(list), rect, yaw, pitch, |res, id| shape(res, id, &mut cache));
}

/// One cube with its own `faces` (a mob's head, say), as [`draw`] draws a block.
pub fn draw_cube(c: &mut Canvas, faces: Faces, rect: [f32; 4], yaw: f32, pitch: f32) {
    draw_with(c, &[([0, 0, 0], String::new())], rect, yaw, pitch, |_, _| cube(faces.clone()));
}

fn draw_with(
    c: &mut Canvas,
    blocks: &[([i32; 3], String)],
    [x, y, w, h]: [f32; 4],
    yaw: f32,
    pitch: f32,
    mut shape_of: impl FnMut(&Resources, &str) -> Shape,
) {
    if blocks.is_empty() || w <= 0.0 || h <= 0.0 {
        return;
    }
    let mut lo = [i32::MAX; 3];
    let mut hi = [i32::MIN; 3];
    for (p, _) in blocks {
        for i in 0..3 {
            lo[i] = lo[i].min(p[i]);
            hi[i] = hi[i].max(p[i]);
        }
    }
    let size = (0..3).map(|i| hi[i] - lo[i]).max().unwrap_or(0) as f32 + 1.0;
    // As the hosts: as big as fits (1.7 × the largest side).
    let s = w.min(h) / (size * 1.7);
    let centre = [(lo[0] + hi[0] + 1) as f32 / 2.0, (lo[1] + hi[1] + 1) as f32 / 2.0, (lo[2] + hi[2] + 1) as f32 / 2.0];
    let (sy, cy) = yaw.to_radians().sin_cos();
    let (sp, cp) = pitch.to_radians().sin_cos();
    // World → view: about Y by yaw, then about X by pitch; x right, y up, z toward the viewer.
    let view = |p: [f32; 3]| {
        let (px, py, pz) = (p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]);
        let x1 = px * cy + pz * sy;
        let z1 = -px * sy + pz * cy;
        let y2 = py * cp - z1 * sp;
        let z2 = py * sp + z1 * cp;
        [x1, y2, z2]
    };
    let screen = |v: [f32; 3]| [x + w / 2.0 + v[0] * s, y + h / 2.0 - v[1] * s];
    let occupied: HashSet<[i32; 3]> = blocks.iter().map(|(p, _)| *p).collect();

    // Every face that can be seen: (depth, texture, corner, edge a, edge b, shade).
    let mut quads = Vec::new();
    // (normal, corner offset, a, b, slot, shade) per face of a unit cube.
    const FACES: [([i32; 3], [f32; 3], [f32; 3], [f32; 3], usize, f32); 6] = [
        ([0, 1, 0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0, 1.0),
        ([0, -1, 0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 0.0, -1.0], 1, 0.5),
        ([0, 0, -1], [1.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, -1.0, 0.0], 2, 0.8),
        ([0, 0, 1], [0.0, 1.0, 1.0], [1.0, 0.0, 0.0], [0.0, -1.0, 0.0], 3, 0.8),
        ([-1, 0, 0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0], 4, 0.6),
        ([1, 0, 0], [1.0, 1.0, 1.0], [0.0, 0.0, -1.0], [0.0, -1.0, 0.0], 5, 0.6),
    ];
    for (p, id) in blocks {
        for cuboid in shape_of(c.resources(), id) {
            let (f, t) = (cuboid.from.map(|v| v / 16.0), cuboid.to.map(|v| v / 16.0));
            // A unit cube's corner → this box's, in the world.
            let at = |u: [f32; 3]| [0, 1, 2].map(|i| p[i] as f32 + f[i] + u[i] * (t[i] - f[i]));
            for (n, corner, a, b, slot, shade) in FACES {
                // On the block's side, against a neighbour: hidden.
                let on_side = (0..3).all(|i| n[i] == 0 || (n[i] > 0 && t[i] >= 1.0) || (n[i] < 0 && f[i] <= 0.0));
                if on_side && occupied.contains(&[p[0] + n[0], p[1] + n[1], p[2] + n[2]]) {
                    continue;
                }
                // Facing away from the viewer: unseen.
                let nv = view([centre[0] + n[0] as f32, centre[1] + n[1] as f32, centre[2] + n[2] as f32]);
                if nv[2] <= 0.0 {
                    continue;
                }
                let Some(img) = cuboid.faces[slot].clone() else { continue };
                let o = at(corner);
                let oa = at([corner[0] + a[0], corner[1] + a[1], corner[2] + a[2]]);
                let ob = at([corner[0] + b[0], corner[1] + b[1], corner[2] + b[2]]);
                let (vo, va, vb) = (view(o), view(oa), view(ob));
                let mid = view([0, 1, 2].map(|i| (oa[i] + ob[i]) / 2.0));
                let (so, sa, sb) = (screen(vo), screen(va), screen(vb));
                quads.push((mid[2], Some(img), so, [sa[0] - so[0], sa[1] - so[1]], [sb[0] - so[0], sb[1] - so[1]], shade));
            }
        }
    }
    // Back to front.
    quads.sort_by(|a, b| a.0.total_cmp(&b.0));
    let missing = Arc::new(Image::missing());
    for (_, img, o, a, b, shade) in quads {
        let img = img.unwrap_or_else(|| missing.clone());
        c.quad(&img, o, a, b, shade);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32) -> Image {
        Image { w, h, rgba: (0..w * h).flat_map(|i| [i as u8, 0, 0, 255]).collect() }
    }

    fn opaque(shape: Shape) -> usize {
        let res = Resources { mod_root: None, vanilla: None };
        let mut c = Canvas::new(32, 32, 1, &res);
        draw_with(&mut c, &[([0, 0, 0], "x".into())], [0.0, 0.0, 32.0, 32.0], 225.0, 30.0, |_, _| shape.clone());
        c.rgba.chunks_exact(4).filter(|p| p[3] > 0).count()
    }

    #[test]
    fn a_models_boxes_are_drawn_their_size_with_their_uv() {
        let img = Arc::new(solid(16, 16));
        let elements: Vec<Value> = serde_json::from_str(
            r##"[{ "from": [5, 5, 5], "to": [11, 11, 11], "faces": {
                "up": { "uv": [5, 5, 11, 11], "texture": "#all" }, "north": { "texture": "#all" } } }]"##,
        )
        .unwrap();
        let shape = shape_of(&elements, &mut |v: &str| (v == "#all").then(|| img.clone()));
        assert_eq!(shape.len(), 1);
        let up = shape[0].faces[0].as_ref().unwrap();
        assert_eq!((up.w, up.h), (6, 6), "the uv's part");
        assert_eq!(up.pixel(0, 0), img.pixel(5, 5));
        let north = shape[0].faces[2].as_ref().unwrap();
        assert_eq!((north.w, north.h), (6, 6), "no uv: the box's own part");
        assert!(shape[0].faces[1].is_none(), "a face the model leaves out isn't drawn");

        let small = opaque(shape);
        let full = opaque(cube(std::array::from_fn(|_| Some(img.clone()))));
        assert!(small > 0 && small * 4 < full, "a cable's core, not a whole block: {small} vs {full}");
    }

    #[test]
    fn parses_block_lines() {
        let b = parse("0 0 0 minecraft:stone\n1 2 -1 minecraft:furnace[facing=north]\nbad");
        assert_eq!(b, [([0, 0, 0], "minecraft:stone".to_string()), ([1, 2, -1], "minecraft:furnace".to_string())]);
    }
}
