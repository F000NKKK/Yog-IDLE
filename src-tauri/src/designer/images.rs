//! `<Image>` in the designer: Yog image sources (`item:apple`,
//! `sprite:button`, `mod:gui/logo`, `mymod:gui/logo` — see
//! `yog_gfx::image`) resolved against the local game files and the mod's
//! `assets/`, the way the Yog runtime resolves them in game: yog-ui's
//! `Image` widget lays out and fits the picture, then calls `draw2d_image`
//! / `image_size`, which the recording table (`gfx`) answers from here.
//! Also the Properties window's `source` picker ([`candidates`],
//! [`preview`]).

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use yog_gfx::image::{
    ImageSource, LegacyRegion, SPRITES, Sprite, Stretch, fit, sprite as find_sprite,
};
use yog_ui::widget::{self, Widget};

use super::assets::{Image, Resources, split_id};
use super::markup::{YuiNode, color};
use super::raster::Canvas;

struct Doc {
    res: Resources,
    mod_id: Option<String>,
}

thread_local! {
    static DOC: RefCell<Option<Doc>> = const { RefCell::new(None) };
}

/// `[mod] id` from `<root>/yog.toml`.
fn mod_id(root: &Path) -> Option<String> {
    crate::manifest::read_mod_field(root, "id")
}

/// The `.yui` being laid out and drawn: its mod's resources (images, fonts)
/// and id (for `mod:` sources). Set before every layout.
pub fn set_document(mod_root: Option<&Path>) {
    let doc = Doc {
        res: Resources::for_mod(mod_root),
        mod_id: mod_root.and_then(mod_id),
    };
    DOC.with(|d| *d.borrow_mut() = Some(doc));
}

/// The current document's resources (vanilla only without one).
pub fn resources() -> Resources {
    DOC.with(|d| d.borrow().as_ref().map(|d| d.res.clone()))
        .unwrap_or_else(|| Resources::for_mod(None))
}

fn with_doc<R>(f: impl FnOnce(Option<&Doc>) -> R) -> R {
    DOC.with(|d| f(d.borrow().as_ref()))
}

/// `mod:<path>` → `<mod id>:<path>` (what `yog build` writes into the
/// generated code); other sources unchanged.
pub fn resolve_mod(source: &str) -> String {
    let source = source.trim();
    match source.strip_prefix("mod:") {
        Some(path) => match with_doc(|d| d.and_then(|d| d.mod_id.clone())) {
            Some(id) => format!("{id}:{path}"),
            None => source.to_string(),
        },
        None => source.to_string(),
    }
}

/// `stretch` attribute → [`Stretch`] (case-insensitive, like `yog build`).
pub fn stretch(v: &str) -> Stretch {
    match v.trim().to_ascii_lowercase().as_str() {
        "none" => Stretch::None,
        "fill" => Stretch::Fill,
        "uniformtofill" | "uniform_to_fill" => Stretch::UniformToFill,
        _ => Stretch::Uniform,
    }
}

/// `uv="u v w h"`.
fn uv(v: &str) -> Option<[f32; 4]> {
    let p: Vec<f32> = v
        .split([' ', ','])
        .filter(|s| !s.is_empty())
        .map(|s| s.parse().ok())
        .collect::<Option<_>>()?;
    <[f32; 4]>::try_from(p)
        .ok()
        .filter(|r| r[2] > 0.0 && r[3] > 0.0)
}

/// The widget for an `<Image>` — what the generated code builds: `source`,
/// `stretch`, `uv`, `tint`.
pub fn widget(node: &YuiNode) -> Widget {
    let a = |k: &str| node.attr(k);
    let source = a("source").unwrap_or_default();
    let mut w = widget::image(resolve_mod(source));
    if let Some(s) = a("stretch") {
        w = w.stretch(stretch(s));
    }
    if let Some(r) = a("uv").and_then(uv) {
        w = w.region(r);
    }
    if let Some(t) = a("tint").and_then(color) {
        w = w.tint(t);
    }
    w
}

fn texture(id: &str) -> Option<Arc<Image>> {
    if let Some(sheet) = book_sheet(id) {
        return Some(sheet);
    }
    with_doc(|d| d.and_then(|d| d.res.texture(id)))
}

/// The book's sprite sheets — shipped in the loader's jars, embedded in
/// yog-book (see `yog_book::BOOK_SHEET`).
fn book_sheet(id: &str) -> Option<Arc<Image>> {
    static SHEETS: std::sync::OnceLock<[Option<Arc<Image>>; 2]> = std::sync::OnceLock::new();
    let [book, crafting] = SHEETS.get_or_init(|| {
        [
            super::assets::decode_png(yog_book::BOOK_PNG).map(Arc::new),
            super::assets::decode_png(yog_book::CRAFTING_PNG).map(Arc::new),
        ]
    });
    match id {
        "yog:textures/gui/book/book.png" => book.clone(),
        "yog:textures/gui/book/crafting.png" => crafting.clone(),
        _ => None,
    }
}

/// The game files have the 1.20.2+ GUI sprite atlas.
fn has_atlas() -> bool {
    texture("minecraft:textures/gui/sprites/widget/button.png").is_some()
}

/// The texture an item/block icon is drawn with (the designer doesn't run
/// the 3D item renderer: block items show a face of the block).
fn item_texture(id: &str, block: bool) -> Option<Arc<Image>> {
    let (ns, name) = split_id(id);
    let item = format!("{ns}:textures/item/{name}.png");
    let blocks =
        ["", "_front", "_side", "_top"].map(|s| format!("{ns}:textures/block/{name}{s}.png"));
    let mut order: Vec<&String> = blocks.iter().collect();
    if block {
        order.push(&item);
    } else {
        order.insert(0, &item);
    }
    order.into_iter().find_map(|t| texture(t)).or_else(|| content_icon(id))
}

/// A mod item's icon from its `content/` file (cached per id).
fn content_icon(id: &str) -> Option<Arc<Image>> {
    type Cache = std::sync::Mutex<std::collections::HashMap<(PathBuf, String), Option<Arc<Image>>>>;
    static CACHE: std::sync::OnceLock<Cache> = std::sync::OnceLock::new();
    let root = with_doc(|d| d.and_then(|d| d.res.mod_root.clone()))?;
    let key = (root.clone(), id.to_string());
    let cache = CACHE.get_or_init(Default::default);
    if let Some(hit) = cache.lock().ok()?.get(&key) {
        return hit.clone();
    }
    let img = crate::content::content_icon(&root, id).and_then(|b| super::assets::decode_png(&b)).map(Arc::new);
    cache.lock().ok()?.insert(key, img.clone());
    img
}

/// Natural size of `source` in GUI pixels (`image_size`); `None` when it
/// can't be resolved.
pub fn source_size(source: &str) -> Option<(f32, f32)> {
    match ImageSource::parse(source)? {
        ImageSource::Item(_) | ImageSource::Block(_) => Some((16.0, 16.0)),
        ImageSource::Sprite(name) => find_sprite(&name).map(|s| s.size(has_atlas())),
        ImageSource::Texture(id) if id.ends_with(".svg") => svg_document(&id).and_then(|d| svg_size(&d)),
        ImageSource::Texture(id) => texture(&id).map(|i| (i.w as f32, i.h as f32)),
        ImageSource::ModPath(_) => None,
    }
}

/// `0xAARRGGBB` → RGBA multipliers.
fn tint(c: u32) -> [f32; 4] {
    [(c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF, c >> 24].map(|v| v as f32 / 255.0)
}

/// `img` pixels `src` (`u v w h`) into GUI `dest` (`x y w h`).
fn blit_px(c: &mut Canvas, img: &Image, dest: [f32; 4], src: [f32; 4], t: u32) {
    let [x, y, w, h] = dest;
    let [u, v, uw, vh] = src;
    if w <= 0.0 || h <= 0.0 || uw <= 0.0 || vh <= 0.0 {
        return;
    }
    let (iw, ih) = (img.w as f32, img.h as f32);
    c.blit(
        img,
        x,
        y,
        w,
        h,
        [u / iw, v / ih, (u + uw) / iw, (v + vh) / ih],
        tint(t),
    );
}

/// A texture region, nine-sliced by `border` when stretched (the runtime's
/// legacy-sprite drawing).
fn nine_slice(c: &mut Canvas, img: &Image, region: [f32; 4], border: f32, dest: [f32; 4], t: u32) {
    let [x, y, w, h] = dest;
    let [u, v, rw, rh] = region;
    let b = border.min(rw / 2.0).min(rh / 2.0).min(w / 2.0).min(h / 2.0);
    if b <= 0.0 || (w == rw && h == rh) {
        blit_px(c, img, dest, region, t);
        return;
    }
    let cols = [
        (x, b, u, b),
        (x + b, w - 2.0 * b, u + b, rw - 2.0 * b),
        (x + w - b, b, u + rw - b, b),
    ];
    let rows = [
        (y, b, v, b),
        (y + b, h - 2.0 * b, v + b, rh - 2.0 * b),
        (y + h - b, b, v + rh - b, b),
    ];
    for (dy, dh, sv, sh) in rows {
        for (dx, dw, su, sw) in cols {
            blit_px(c, img, [dx, dy, dw, dh], [su, sv, sw, sh], t);
        }
    }
}

/// The inventory slot (drawn by Yog on every version).
fn slot(c: &mut Canvas, [x, y, w, h]: [f32; 4]) {
    c.fill(x, y, x + w, y + h, 0xFF_8B8B8B, 0xFF_8B8B8B);
    c.fill(x, y, x + w, y + 1.0, 0xFF_373737, 0xFF_373737);
    c.fill(x, y, x + 1.0, y + h, 0xFF_373737, 0xFF_373737);
    c.fill(x, y + h - 1.0, x + w, y + h, 0xFF_FFFFFF, 0xFF_FFFFFF);
    c.fill(x + w - 1.0, y, x + w, y + h, 0xFF_FFFFFF, 0xFF_FFFFFF);
}

fn sprite(c: &mut Canvas, sp: &Sprite, dest: [f32; 4], t: u32) {
    if sp.is_procedural() {
        slot(c, dest);
        return;
    }
    if let Some(atlas) = sp.atlas
        && let Some(img) = texture(&format!("minecraft:textures/gui/sprites/{atlas}.png"))
    {
        // Animated sprites stack their frames vertically: the first one.
        let frame_h = if img.h > img.w && sp.h <= sp.w {
            img.w as f32 * sp.h / sp.w
        } else {
            img.h as f32
        };
        nine_slice(
            c,
            &img,
            [0.0, 0.0, img.w as f32, frame_h],
            sp.border,
            dest,
            t,
        );
        return;
    }
    if let Some(LegacyRegion {
        texture: tex,
        u,
        v,
        w,
        h,
        tex_w,
        ..
    }) = sp.legacy
        && let Some(img) = texture(tex)
    {
        // Resource packs may ship the sheet at a higher resolution.
        let k = img.w as f32 / tex_w;
        nine_slice(
            c,
            &img,
            [u * k, v * k, w * k, h * k],
            sp.border * k,
            dest,
            t,
        );
        return;
    }
    missing(c, dest);
}

fn missing(c: &mut Canvas, dest: [f32; 4]) {
    blit_px(
        c,
        &Image::missing(),
        dest,
        [0.0, 0.0, 16.0, 16.0],
        0xFFFF_FFFF,
    );
}

/// Physical pixels an SVG is rasterized at per GUI pixel.
const SVG_OVERSAMPLE: f32 = 4.0;

/// An SVG document as straight-alpha RGBA, `w`×`h` — as the runtime
/// rasterizes it in game.
fn svg_image(data: &str, w: u32, h: u32) -> Option<Image> {
    let tree = resvg::usvg::Tree::from_str(data, &resvg::usvg::Options::default()).ok()?;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(w, h)?;
    let size = tree.size();
    let t = resvg::tiny_skia::Transform::from_scale(w as f32 / size.width(), h as f32 / size.height());
    resvg::render(&tree, t, &mut pixmap.as_mut());
    let mut rgba = pixmap.take();
    for p in rgba.as_chunks_mut::<4>().0 {
        let a = p[3] as u32;
        if a > 0 && a < 255 {
            for c in &mut p[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
    Some(Image { w, h, rgba })
}

/// The document of an `.svg` texture id (`ns:textures/x.svg`) of the mod.
fn svg_document(id: &str) -> Option<String> {
    let (ns, path) = split_id(id);
    let bytes = with_doc(|d| d.and_then(|d| d.res.read(ns, path)))?;
    String::from_utf8(bytes).ok()
}

fn svg_size(data: &str) -> Option<(f32, f32)> {
    let tree = resvg::usvg::Tree::from_str(data, &resvg::usvg::Options::default()).ok()?;
    Some((tree.size().width(), tree.size().height()))
}

/// `draw2d_svg`: `data` into `dest`.
pub fn draw_svg(c: &mut Canvas, data: &str, dest: [f32; 4], t: u32) {
    if dest[2] <= 0.0 || dest[3] <= 0.0 {
        return;
    }
    let side = |v: f32| ((v * SVG_OVERSAMPLE).ceil() as u32).clamp(1, 2048);
    match svg_image(data, side(dest[2]), side(dest[3])) {
        Some(img) => blit_px(c, &img, dest, [0.0, 0.0, img.w as f32, img.h as f32], t),
        None => missing(c, dest),
    }
}

/// `draw2d_entity`: the designer has no entity models — the entity's spawn
/// egg, in the middle of its box.
pub fn draw_entity(c: &mut Canvas, entity: &str, [x, y, w, h]: [f32; 4]) {
    let (ns, path) = split_id(entity);
    let side = w.min(h).min(32.0);
    let dest = [x + (w - side) / 2.0, y + (h - side) / 2.0, side, side];
    draw(c, &format!("item:{ns}:{path}_spawn_egg"), dest, [0.0; 4], 0xFFFF_FFFF);
}

/// `draw2d_image`: `source` into `dest` (`x y w h`, already fitted by
/// yog-ui); `region` `u v w h` in image pixels (`w <= 0`: whole image).
pub fn draw(c: &mut Canvas, source: &str, dest: [f32; 4], region: [f32; 4], t: u32) {
    if dest[2] <= 0.0 || dest[3] <= 0.0 {
        return;
    }
    if let Some(ImageSource::Texture(id)) = ImageSource::parse(source)
        && id.ends_with(".svg")
    {
        match svg_document(&id) {
            Some(doc) => draw_svg(c, &doc, dest, t),
            None => missing(c, dest),
        }
        return;
    }
    let first_frame = |img: &Image| [0.0, 0.0, img.w as f32, img.w.min(img.h) as f32];
    match ImageSource::parse(source) {
        Some(ImageSource::Item(id)) => match item_texture(&id, false) {
            Some(img) => blit_px(c, &img, dest, first_frame(&img), 0xFFFF_FFFF),
            None => missing(c, dest),
        },
        Some(ImageSource::Block(id)) => match item_texture(&id, true) {
            Some(img) => blit_px(c, &img, dest, first_frame(&img), 0xFFFF_FFFF),
            None => missing(c, dest),
        },
        Some(ImageSource::Sprite(name)) => match find_sprite(&name) {
            Some(sp) => sprite(c, sp, dest, t),
            None => match name
                .split_once(':')
                .and_then(|(ns, p)| texture(&format!("{ns}:textures/gui/sprites/{p}.png")))
            {
                Some(img) => blit_px(c, &img, dest, [0.0, 0.0, img.w as f32, img.h as f32], t),
                None => missing(c, dest),
            },
        },
        Some(ImageSource::Texture(id)) => match texture(&id) {
            Some(img) => {
                let src = if region[2] > 0.0 && region[3] > 0.0 {
                    region
                } else {
                    [0.0, 0.0, img.w as f32, img.h as f32]
                };
                blit_px(c, &img, dest, src, t);
            }
            None => missing(c, dest),
        },
        Some(ImageSource::ModPath(_)) | None => missing(c, dest),
    }
}

/// An alias the Properties picker offers.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Candidate {
    /// The source to write (`item:apple`, `sprite:button`, `mod:gui/logo`).
    pub source: String,
    /// `item`, `block`, `sprite` or `mod`.
    pub group: String,
    pub detail: String,
}

/// `.png` files under `dir` (recursively), as paths relative to it without the extension.
fn pngs(dir: &Path, prefix: &str, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let p = e.path();
        if p.is_dir() {
            pngs(&p, &format!("{prefix}{name}/"), out);
        } else if let Some(stem) = name.strip_suffix(".png") {
            out.push(format!("{prefix}{stem}"));
        }
    }
}

/// Everything the `source` picker offers for the `.yui` at `path`: the
/// mod's own textures, the sprite table, then the game's items and blocks.
pub fn candidates(path: &Path) -> Vec<Candidate> {
    let root = super::mod_root(path);
    let mut out = Vec::new();
    if let Some(root) = &root
        && let Some(id) = mod_id(root)
    {
        let mut own = Vec::new();
        for base in [
            root.join("assets"),
            root.join("src/assets"),
            root.join("resources/assets"),
        ] {
            pngs(&base.join(&id).join("textures"), "", &mut own);
        }
        own.sort();
        own.dedup();
        out.extend(own.into_iter().map(|p| Candidate {
            source: format!("mod:{p}"),
            group: "mod".into(),
            detail: format!("assets/{id}/textures/{p}.png"),
        }));
    }
    out.extend(SPRITES.iter().map(|s| Candidate {
        source: format!("sprite:{}", s.name),
        group: "sprite".into(),
        detail: format!("{} ({}×{})", s.description, s.w, s.h),
    }));
    let res = Resources::for_mod(root.as_deref());
    if let Some(v) = &res.vanilla {
        let (items, blocks) = v.texture_names();
        out.extend(items.into_iter().map(|n| Candidate {
            source: format!("item:{n}"),
            group: "item".into(),
            detail: String::new(),
        }));
        out.extend(blocks.into_iter().map(|n| Candidate {
            source: format!("block:{n}"),
            group: "block".into(),
            detail: String::new(),
        }));
    }
    out
}

/// A preview of `source` as a PNG data URL (`size` px, nearest-neighbour).
pub fn preview(path: &Path, source: &str, size: u32) -> Option<String> {
    use base64::Engine as _;
    let root = super::mod_root(path);
    set_document(root.as_deref());
    let size = size.clamp(8, 256);
    let res = Resources::for_mod(root.as_deref());
    let mut c = Canvas::new(size, size, 1, &res);
    let source = resolve_mod(source);
    let (nw, nh) = source_size(&source).unwrap_or((16.0, 16.0));
    let ([x, y, w, h], _) = fit(Stretch::Uniform, nw, nh, 0.0, 0.0, size as f32, size as f32);
    draw(&mut c, &source, [x, y, w, h], [0.0; 4], 0xFFFF_FFFF);
    let png = c.png().ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attributes_parse_like_yog_build() {
        assert_eq!(stretch("UniformToFill"), Stretch::UniformToFill);
        assert_eq!(stretch("fill"), Stretch::Fill);
        assert_eq!(stretch("bogus"), Stretch::Uniform);
        assert_eq!(uv("0 0 16 8"), Some([0.0, 0.0, 16.0, 8.0]));
        assert_eq!(uv("0 0 0 8"), None);
        assert_eq!(source_size("item:apple"), Some((16.0, 16.0)));
        assert_eq!(source_size("nonsense"), None);
    }

    /// `YOG_IMAGES_PNG=out.png cargo test --lib designer::images -- --ignored`:
    /// every kind of source drawn with the local game files, for eyeballing.
    #[test]
    #[ignore]
    fn sample_png() {
        use base64::Engine as _;
        let Ok(out) = std::env::var("YOG_IMAGES_PNG") else {
            return;
        };
        let n = |uid: &str, attrs: &[(&str, &str)]| YuiNode {
            uid: uid.into(),
            kind: "Image".into(),
            attrs: attrs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            children: vec![],
        };
        let mut root = n(
            "s",
            &[("width", "200"), ("height", "120"), ("bg", "#C0101010")],
        );
        root.kind = "Screen".into();
        root.children = vec![
            // w/h larger than the texture.
            n(
                "a",
                &[
                    ("x", "4"),
                    ("y", "4"),
                    ("w", "156"),
                    ("h", "29"),
                    ("source", "minecraft:item/apple"),
                    ("bg", "#40FFFFFF"),
                ],
            ),
            n(
                "b",
                &[
                    ("x", "4"),
                    ("y", "36"),
                    ("w", "32"),
                    ("h", "32"),
                    ("source", "item:apple"),
                ],
            ),
            n(
                "c",
                &[
                    ("x", "40"),
                    ("y", "36"),
                    ("w", "32"),
                    ("h", "32"),
                    ("source", "block:crafting_table"),
                ],
            ),
            n(
                "d",
                &[
                    ("x", "76"),
                    ("y", "36"),
                    ("w", "100"),
                    ("h", "20"),
                    ("source", "sprite:button"),
                    ("stretch", "Fill"),
                ],
            ),
            n(
                "e",
                &[("x", "76"), ("y", "60"), ("source", "sprite:icon/heart")],
            ),
            n("f", &[("x", "90"), ("y", "60"), ("source", "sprite:slot")]),
            n(
                "g",
                &[
                    ("x", "4"),
                    ("y", "72"),
                    ("w", "64"),
                    ("h", "40"),
                    ("source", "item:diamond"),
                    ("stretch", "Fill"),
                    ("tint", "#FF80FF80"),
                ],
            ),
        ];
        let args = super::super::RenderArgs {
            path: "/nowhere/src/x.yui".into(),
            root,
            screen_w: 200,
            screen_h: 120,
            scale: 4,
            preview: false,
        };
        let r = super::super::render(&args).unwrap();
        let b64 = r.image.trim_start_matches("data:image/png;base64,");
        std::fs::write(
            out,
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .unwrap(),
        )
        .unwrap();
        eprintln!("assets: {:?}", r.assets);
    }
}
