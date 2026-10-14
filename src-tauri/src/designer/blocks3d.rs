//! `draw2d_blocks` in the designer: blocks in 3D, as the game draws them in
//! a GUI (an orthographic view, turned and tilted), each block a cube with
//! its model's textures — the faces you'd see, back to front, the top lit,
//! the sides shaded like Minecraft's. Shapes other than cubes (stairs,
//! torches) show as cubes: enough to see a structure.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde_json::Value;

use super::assets::{Image, Resources, decode_png, split_id};
use super::raster::Canvas;

/// A face's textures: top, sides, bottom.
type Faces = [Option<Arc<Image>>; 3];

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

fn faces(res: &Resources, id: &str, cache: &mut HashMap<String, Faces>) -> Faces {
    if let Some(f) = cache.get(id) {
        return f.clone();
    }
    // The mod's own block: its `.yblock` model's textures.
    if let Some(faces) = res.mod_root.as_deref().and_then(|root| crate::content::content_block_faces(root, id)) {
        let f: Faces = faces.map(|b| b.and_then(|b| decode_png(&b)).map(Arc::new));
        cache.insert(id.to_string(), f.clone());
        return f;
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
    let f: Faces = [
        load(pick(&["up", "top", "end", "all", "texture", "particle"])),
        load(pick(&["north", "side", "front", "all", "texture", "particle"])),
        load(pick(&["down", "bottom", "end", "all", "texture", "particle"])),
    ];
    cache.insert(id.to_string(), f.clone());
    f
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

pub fn draw(c: &mut Canvas, list: &str, [x, y, w, h]: [f32; 4], yaw: f32, pitch: f32) {
    let blocks = parse(list);
    if blocks.is_empty() || w <= 0.0 || h <= 0.0 {
        return;
    }
    let mut lo = [i32::MAX; 3];
    let mut hi = [i32::MIN; 3];
    for (p, _) in &blocks {
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

    // Every face that can be seen: (depth, block, corner, edge a, edge b, texture slot, shade).
    let mut cache = HashMap::new();
    let mut quads = Vec::new();
    // (normal, corner offset, a, b, slot, shade) per face of a unit cube.
    const FACES: [([i32; 3], [f32; 3], [f32; 3], [f32; 3], usize, f32); 6] = [
        ([0, 1, 0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0, 1.0),
        ([0, -1, 0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 0.0, -1.0], 2, 0.5),
        ([0, 0, -1], [1.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, -1.0, 0.0], 1, 0.8),
        ([0, 0, 1], [0.0, 1.0, 1.0], [1.0, 0.0, 0.0], [0.0, -1.0, 0.0], 1, 0.8),
        ([-1, 0, 0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0], 1, 0.6),
        ([1, 0, 0], [1.0, 1.0, 1.0], [0.0, 0.0, -1.0], [0.0, -1.0, 0.0], 1, 0.6),
    ];
    for (p, id) in &blocks {
        let f = faces(c.resources(), id, &mut cache);
        for (n, corner, a, b, slot, shade) in FACES {
            if occupied.contains(&[p[0] + n[0], p[1] + n[1], p[2] + n[2]]) {
                continue;
            }
            // Facing away from the viewer: unseen.
            let nv = view([centre[0] + n[0] as f32, centre[1] + n[1] as f32, centre[2] + n[2] as f32]);
            if nv[2] <= 0.0 {
                continue;
            }
            let o = [p[0] as f32 + corner[0], p[1] as f32 + corner[1], p[2] as f32 + corner[2]];
            let oa = [o[0] + a[0], o[1] + a[1], o[2] + a[2]];
            let ob = [o[0] + b[0], o[1] + b[1], o[2] + b[2]];
            let (vo, va, vb) = (view(o), view(oa), view(ob));
            let mid = view([p[0] as f32 + 0.5 + n[0] as f32 * 0.5, p[1] as f32 + 0.5 + n[1] as f32 * 0.5, p[2] as f32 + 0.5 + n[2] as f32 * 0.5]);
            let (so, sa, sb) = (screen(vo), screen(va), screen(vb));
            quads.push((mid[2], f[slot].clone(), so, [sa[0] - so[0], sa[1] - so[1]], [sb[0] - so[0], sb[1] - so[1]], shade));
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

    #[test]
    fn parses_block_lines() {
        let b = parse("0 0 0 minecraft:stone\n1 2 -1 minecraft:furnace[facing=north]\nbad");
        assert_eq!(b, [([0, 0, 0], "minecraft:stone".to_string()), ([1, 2, -1], "minecraft:furnace".to_string())]);
    }
}
