//! A mod's images: the image entries of its `.yres` files (a mod has no
//! `assets/`; the build puts each under `textures/`, see
//! `yog_formats::yres::image_texture`).

use std::path::{Path, PathBuf};

use serde_json::Value;
use yog_formats::yres::{Kind, image_texture, split_file_name};
use yog_ids::Format;

/// Where a mod's resources live, under its root.
pub const RESOURCES_DIR: &str = "resources";

/// One image entry.
#[derive(Debug, Clone, PartialEq)]
pub struct YresImage {
    /// Its set (`Textures` for `Textures.yres`) and name: `@Textures.logo`.
    pub set: String,
    pub name: String,
    /// The png.
    pub file: PathBuf,
    /// Its texture path under `textures/`, without `.png`.
    pub texture: String,
}

/// Every image entry of the mod at `root`.
pub fn images(root: &Path) -> Vec<YresImage> {
    let resources = root.join(RESOURCES_DIR);
    let mut out = Vec::new();
    for file in crate::files::of(&resources, Format::Res) {
        // A culture variant (`Textures.ru_ru.yres`) has no images of its own.
        let Some((set, None)) = file.file_name().and_then(|n| n.to_str()).and_then(split_file_name) else { continue };
        let set = set.to_string();
        let Some(doc) = std::fs::read_to_string(&file).ok().and_then(|t| crate::data::read_object(&t)) else { continue };
        let dir = file.parent().unwrap_or(&resources);
        for (name, entry) in &doc {
            let (value, texture) = match entry {
                Value::Object(o) if o.get("type").and_then(Value::as_str) == Some(Kind::Image.name()) => {
                    (o.get("value").and_then(Value::as_str), o.get("texture").and_then(Value::as_str))
                }
                Value::String(s) if s.ends_with(yog_ids::res::PNG) => (Some(s.as_str()), None),
                _ => continue,
            };
            let Some(value) = value else { continue };
            let full = dir.join(value);
            let Some(rel) = full.strip_prefix(&resources).ok().map(|p| p.to_string_lossy().replace('\\', yog_ids::sep::PATH)) else { continue };
            let Some(texture) = image_texture(&rel, texture) else { continue };
            out.push(YresImage { set: set.clone(), name: name.clone(), file: full, texture });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn images_are_found_by_set_and_texture() {
        let dir = std::env::temp_dir().join(format!("yog-yres-images-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("resources/gui")).unwrap();
        std::fs::write(dir.join("resources/gui/book.png"), b"png").unwrap();
        std::fs::write(
            dir.join("resources/Textures.yres"),
            r#"{ "book": { "type": "image", "value": "gui/book.png", "texture": "gui/patchi_book" }, "plain": "gui/book.png" }"#,
        )
        .unwrap();
        let found = images(&dir);
        assert!(found.iter().any(|i| i.set == "Textures" && i.name == "book" && i.texture == "gui/patchi_book"));
        assert!(found.iter().any(|i| i.name == "plain" && i.texture == "gui/book"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Hex Casting's book sheet — a `.yres` image with a texture path of its own.
    #[test]
    #[ignore = "needs ../HexMod-Yog"]
    fn hex_book_sheet_resolves() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../HexMod-Yog");
        let res = crate::designer::assets::Resources { mod_root: Some(root), vanilla: None };
        assert!(res.texture("hexcasting:textures/gui/patchi_book.png").is_some());
    }
}
