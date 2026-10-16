//! The mod's own kinds of recipe (`.ydef` `kind: "recipe_kind"`), for the
//! recipe editor: their slots and values, and — when a `.yui`
//! `recipe_layout` shows the kind — its picture (images, the station, slot
//! frames) drawn as books draw it, with where its slots, result and texts
//! go on it.

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
    /// The `.yui` it's laid out in.
    pub file: String,
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

/// The game's kinds the recipe editor lays out — as books show them (their
/// built-in layouts, or the mod's own `recipe_layout` for them): the
/// crafting grid's 9 places (`grid`), a furnace's or a stonecutter's input.
pub fn game_kinds(root: &Path) -> Vec<Kind> {
    let layouts = crate::mod_ui::recipe_layouts(root);
    let own: Vec<yog_book::layout::RecipeLayout> = layouts.iter().map(|(_, l)| l.clone()).collect();
    [
        ("shaped", "grid", 9),
        ("shapeless", "grid", 9),
        ("smelting", "input", 1),
        ("blasting", "input", 1),
        ("smoking", "input", 1),
        ("campfire_cooking", "input", 1),
        ("stonecutting", "input", 1),
    ]
        .into_iter()
        .map(|(id, slot, max)| {
            let file = layouts.iter().find(|(_, l)| l.kinds.iter().any(|k| k == id)).map(|(f, _)| f.clone()).unwrap_or_default();
            Kind {
                id: id.to_string(),
                file: String::new(),
                slots: vec![Slot { name: slot.to_string(), max, required: true }],
                values: Vec::new(),
                layout: yog_book::layout::find(&own, id).map(|l| layout(root, &file, l.size, &l.parts)),
            }
        })
        .collect()
}

/// The kinds the mod at `root` declares, by id.
pub fn kinds(root: &Path) -> Vec<Kind> {
    let ns = crate::manifest::read_mod_field(root, "id").unwrap_or_default();
    let mut files = Vec::new();
    ydefs(&root.join("content"), &mut files);
    files.sort();
    let layouts = crate::mod_ui::recipe_layouts(root);
    let mut out: Vec<Kind> = files
        .iter()
        .filter_map(|file| {
            let text = std::fs::read_to_string(file).ok()?;
            let Def::RecipeKind(k) = yog_data::from_text::<Def>(&text).ok()?.value else { return None };
            Some(kind(root, &ns, file, k, &layouts))
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn kind(root: &Path, ns: &str, file: &Path, k: RecipeKindDef, layouts: &[(PathBuf, yog_book::layout::RecipeLayout)]) -> Kind {
    let id = if k.id.contains(':') { k.id.clone() } else { format!("{ns}:{}", k.id) };
    Kind {
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
        layout: layouts.iter().find(|(_, l)| l.kinds.contains(&id)).map(|(f, l)| layout(root, f, l.size, &l.parts)),
        id,
    }
}

/// The picture of `parts` (what doesn't change with the recipe) and the spots.
fn layout(root: &Path, file: &Path, size: [f32; 2], parts: &[LayoutPart]) -> Layout {
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
    Layout { file: file.to_string_lossy().into_owned(), size, image, scale: SCALE, spots }
}

/// A new kind's `.ydef`: two slots and a value to start from.
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
}}
"#
    )
}

/// A new kind's layout (`src/ui/<id>_layout.yui`), for the screen designer:
/// the template's slots framed, the result, its time.
pub fn layout_template(id: &str) -> String {
    format!(
        r#"<!-- How recipes of {id} are shown: in books and in the recipe editor. -->
<Component recipe_layout="{id}" width="100" height="40">
    <RecipeSlot slot="input" x="4" y="12" frame="true" d:item="minecraft:iron_ore"/>
    <RecipeSlot slot="extra" x="30" y="4" frame="true"/>
    <RecipeSlot slot="extra" x="30" y="22" frame="true"/>
    <RecipeResult x="78" y="12" frame="true" d:item="minecraft:iron_ingot"/>
    <Label text="{{x:Bind time}} ticks" x="50" y="32"/>
</Component>
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
        std::fs::create_dir_all(dir.join("src/ui")).unwrap();
        std::fs::write(dir.join("src/ui/crusher_layout.yui"), layout_template("crusher")).unwrap();
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
        assert!(l.file.ends_with("crusher_layout.yui"));
        let game = game_kinds(&dir);
        assert_eq!(game.iter().map(|k| k.id.as_str()).collect::<Vec<_>>(), ["shaped", "shapeless", "smelting", "blasting", "smoking", "campfire_cooking", "stonecutting"]);
        let shaped = game[0].layout.as_ref().unwrap();
        assert_eq!(shaped.spots.iter().filter(|s| matches!(s, Spot::Slot { slot, .. } if slot == "grid")).count(), 9, "the crafting table's own picture");
        // What the recipe editor reads (recipeModel.ts `RecipeKind`).
        let json = serde_json::to_value(&l.spots).unwrap();
        let types: Vec<&str> = json.as_array().unwrap().iter().map(|s| s["type"].as_str().unwrap()).collect();
        assert_eq!(types, ["slot", "slot", "slot", "result", "text"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
