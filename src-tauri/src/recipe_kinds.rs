//! The mod's own kinds of recipe (`.ydef` `kind: "recipe_kind"`), for the
//! recipe editor: their slots and values, and — when the kind has a
//! `layout` — its picture (images, the station, slot frames) drawn as
//! books draw it, with where its slots, result and texts go on it.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::Serialize;
use yog_book::layout::{FRAME_UV, LayoutPart, SHEET};
use yog_formats::def::{Def, RecipeKindDef, ValueType};

use crate::designer::{assets::Resources, gfx, images, raster};

/// How much bigger than GUI pixels the picture is drawn.
const SCALE: u32 = 3;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    pub name: String,
    pub max: u32,
    pub required: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueSpec {
    pub name: String,
    /// `number`, `text` or `bool`.
    pub kind: &'static str,
}

/// Something the editor puts on the picture, in GUI pixels.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum Spot {
    /// The `index`-th ingredient of `slot`.
    Slot { slot: String, index: usize, at: [f32; 2] },
    Result { at: [f32; 2] },
    Count { at: [f32; 2] },
    /// `{name}` is the recipe's value of that name.
    Text { text: String, at: [f32; 2] },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub size: [f32; 2],
    /// The picture, `SCALE`× GUI pixels, `data:image/png;base64,…`.
    pub image: Option<String>,
    pub scale: u32,
    pub spots: Vec<Spot>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kind {
    pub id: String,
    /// The `.ydef` that declares it.
    pub file: String,
    pub slots: Vec<Slot>,
    pub values: Vec<ValueSpec>,
    pub layout: Option<Layout>,
}

fn ydefs(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            ydefs(&p, out);
        } else if p.extension().is_some_and(|x| x == "ydef") {
            out.push(p);
        }
    }
}

/// The kinds the mod at `root` declares, by id.
pub fn kinds(root: &Path) -> Vec<Kind> {
    let ns = crate::manifest::read_mod_field(root, "id").unwrap_or_default();
    let mut files = Vec::new();
    ydefs(&root.join("content"), &mut files);
    files.sort();
    let mut out: Vec<Kind> = files
        .iter()
        .filter_map(|file| {
            let text = std::fs::read_to_string(file).ok()?;
            let Def::RecipeKind(k) = yog_data::from_text::<Def>(&text).ok()?.value else { return None };
            Some(kind(root, &ns, file, k))
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn kind(root: &Path, ns: &str, file: &Path, k: RecipeKindDef) -> Kind {
    let id = if k.id.contains(':') { k.id.clone() } else { format!("{ns}:{}", k.id) };
    Kind {
        id,
        file: file.to_string_lossy().into_owned(),
        slots: k.slots.0.iter().map(|(name, s)| Slot { name: name.clone(), max: s.max, required: s.required }).collect(),
        values: k
            .values
            .0
            .iter()
            .map(|(name, t)| ValueSpec {
                name: name.clone(),
                kind: match t {
                    ValueType::Number => "number",
                    ValueType::Text => "text",
                    ValueType::Bool => "bool",
                },
            })
            .collect(),
        layout: k.layout.map(|l| layout(root, l.size, &l.parts)),
    }
}

/// The picture of `parts` (what doesn't change with the recipe) and the spots.
fn layout(root: &Path, size: [f32; 2], parts: &[LayoutPart]) -> Layout {
    let mut spots = Vec::new();
    for p in parts {
        match p {
            LayoutPart::Slots { slot, at, .. } => {
                spots.extend(at.iter().enumerate().map(|(index, at)| Spot::Slot { slot: slot.clone(), index, at: *at }));
            }
            LayoutPart::Result { at, .. } => spots.push(Spot::Result { at: *at }),
            LayoutPart::Count { at } => spots.push(Spot::Count { at: *at }),
            LayoutPart::Text { text, at } => spots.push(Spot::Text { text: text.clone(), at: *at }),
            LayoutPart::Image { .. } | LayoutPart::Item { .. } => {}
        }
    }
    let (w, h) = (size[0].ceil().max(1.0) as u32, size[1].ceil().max(1.0) as u32);
    let ops = gfx::record(w as i32, h as i32, |ctx| {
        let d = ctx.draw2d();
        let frame = |[x, y]: [f32; 2]| d.image_region(SHEET, x - 4.0, y - 4.0, FRAME_UV[2], FRAME_UV[3], FRAME_UV, 0xFFFF_FFFF);
        for p in parts {
            match p {
                LayoutPart::Image { source, uv, at } => d.image_region(source, at[0], at[1], uv[2], uv[3], *uv, 0xFFFF_FFFF),
                LayoutPart::Item { item, at } => d.item(item, at[0], at[1], 16.0),
                LayoutPart::Slots { at, frame: true, .. } => at.iter().for_each(|a| frame(*a)),
                LayoutPart::Result { at, frame: true } => frame(*at),
                _ => {}
            }
        }
    });
    images::set_document(Some(root));
    let res = Resources::for_mod(Some(root));
    let image = raster::rasterize(&ops, w, h, SCALE, &res)
        .png()
        .ok()
        .map(|png| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)));
    Layout { size, image, scale: SCALE, spots }
}

/// A new kind's `.ydef`: two slots, a value, a layout to start from.
pub fn template(id: &str) -> String {
    format!(
        r#"{{
  kind: "recipe_kind",
  id: "{id}",
  // Named slots: how many ingredients each takes.
  slots: {{
    input: {{ required: true }},
    extra: {{ max: 2 }},
  }},
  // Named values a recipe of the kind gives (number, text, bool).
  values: {{ time: "number" }},
  // How the recipe editor and books show it, in GUI pixels.
  layout: {{
    size: [100, 32],
    parts: [
      {{ type: "slots", slot: "input", at: [[4, 8]], frame: true }},
      {{ type: "slots", slot: "extra", at: [[28, 0], [28, 16]], frame: true }},
      {{ type: "result", at: [76, 8], frame: true }},
      {{ type: "text", text: "{{time}} ticks", at: [48, 24] }},
    ],
  }},
}}
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_mods_kinds_and_lays_them_out() {
        let dir = std::env::temp_dir().join(format!("yog-idle-kinds-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("content/machines")).unwrap();
        std::fs::write(dir.join("yog.toml"), "[mod]\nid = \"mymod\"\n").unwrap();
        std::fs::write(dir.join("content/machines/crusher.ydef"), template("crusher")).unwrap();
        std::fs::write(dir.join("content/other.ydef"), r#"{ kind: "sound_group", id: "x" }"#).unwrap();
        let ks = kinds(&dir);
        assert_eq!(ks.len(), 1);
        let k = &ks[0];
        assert_eq!(k.id, "mymod:crusher");
        assert_eq!(k.slots.iter().map(|s| (s.name.as_str(), s.max, s.required)).collect::<Vec<_>>(), [("input", 1, true), ("extra", 2, false)]);
        assert_eq!(k.values[0].kind, "number");
        let l = k.layout.as_ref().unwrap();
        assert!(l.image.as_deref().is_some_and(|i| i.starts_with("data:image/png")));
        assert_eq!(l.spots.iter().filter(|s| matches!(s, Spot::Slot { .. })).count(), 3);
        assert!(l.spots.iter().any(|s| matches!(s, Spot::Text { text, .. } if text == "{time} ticks")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
