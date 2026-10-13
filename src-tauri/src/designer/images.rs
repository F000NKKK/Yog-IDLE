//! `<Image>` in the designer: Yog image sources (`item:apple`,
//! `sprite:button`, `mod:gui/logo`, `mymod:gui/logo` — see
//! [`yog_image`](super::yog_image)) resolved against the local game files
//! and the mod's `assets/`, the way the Yog runtime resolves them in game.
//!
//! The published yog-ui (0.35) only has `McImage` (a raw texture blit at
//! its natural size), so an `<Image>` is built as an `McImage` whose id
//! carries the whole element ([`encode`]), resized to its laid-out content
//! box ([`fit_to_layout`]); the recording `draw2d_mc_tex` turns it back into
//! a [`DrawOp::Image`](super::raster::DrawOp::Image) and the rasterizer draws
//! it here ([`draw`]). With yog-ui 0.36 on crates.io this becomes
//! `widget::image(..)` + `draw2d_image`, same as the generated code.

use std::cell::RefCell;
use std::path::Path;
use std::sync::Arc;

use yog_ui::layout::LayoutNode;
use yog_ui::widget::{Widget, WidgetKind};

use super::assets::{split_id, Image, Resources};
use super::markup::{color, YuiNode};
use super::raster::Canvas;
use super::yog_image::{self as yi, fit, ImageSource, LegacyRegion, Sprite, Stretch};

/// Prefix of an encoded `<Image>` in an `McImage` id.
const PREFIX: &str = "yog-image:";

struct Doc {
    res: Resources,
    mod_id: Option<String>,
}

thread_local! {
    static DOC: RefCell<Option<Doc>> = const { RefCell::new(None) };
}

/// `[mod] id` from `<root>/yog.toml`.
fn mod_id(root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(root.join("yog.toml")).ok()?;
    let doc: toml::Table = text.parse().ok()?;
    doc.get("mod")?.get("id")?.as_str().map(str::to_string)
}

/// The `.yui` being laid out (for `mod:` sources and image sizes).
pub fn set_document(mod_root: Option<&Path>) {
    let doc = Doc { res: Resources::for_mod(mod_root), mod_id: mod_root.and_then(mod_id) };
    DOC.with(|d| *d.borrow_mut() = Some(doc));
}

fn with_doc<R>(f: impl FnOnce(Option<&Doc>) -> R) -> R {
    DOC.with(|d| f(d.borrow().as_ref()))
}

/// What an `<Image>` asks for (the `.yui` attributes, parsed).
#[derive(Debug, Clone, PartialEq)]
pub struct Spec {
    pub source: String,
    pub stretch: Stretch,
    /// Source region `u v w h` in image pixels.
    pub uv: Option<[f32; 4]>,
    pub tint: u32,
}

pub fn stretch(v: &str) -> Stretch {
    match v.trim().to_ascii_lowercase().as_str() {
        "none" => Stretch::None,
        "fill" => Stretch::Fill,
        "uniformtofill" | "uniform_to_fill" => Stretch::UniformToFill,
        _ => Stretch::Uniform,
    }
}

fn uv(v: &str) -> Option<[f32; 4]> {
    let p: Vec<f32> = v.split([' ', ',']).filter(|s| !s.is_empty()).map(|s| s.parse().ok()).collect::<Option<_>>()?;
    <[f32; 4]>::try_from(p).ok().filter(|r| r[2] > 0.0 && r[3] > 0.0)
}

impl Spec {
    /// From an `<Image>` node: `source` (or the deprecated `texture`),
    /// `stretch`, `uv`, `tint`.
    pub fn of(node: &YuiNode) -> Spec {
        let source = node.attr("source").or_else(|| node.attr("texture")).unwrap_or_default().trim().to_string();
        Spec {
            source,
            stretch: node.attr("stretch").map(stretch).unwrap_or_default(),
            uv: node.attr("uv").and_then(uv),
            tint: node.attr("tint").and_then(color).unwrap_or(0xFFFF_FFFF),
        }
    }

    fn encode(&self) -> String {
        let uv = self.uv.map_or("-".to_string(), |[u, v, w, h]| format!("{u},{v},{w},{h}"));
        format!("{PREFIX}{}|{uv}|{:08X}|{}", self.stretch as u8, self.tint, self.source)
    }

    pub fn decode(id: &str) -> Option<Spec> {
        let mut parts = id.strip_prefix(PREFIX)?.splitn(4, '|');
        let stretch = match parts.next()? {
            "0" => Stretch::None,
            "1" => Stretch::Fill,
            "3" => Stretch::UniformToFill,
            _ => Stretch::Uniform,
        };
        let uv = uv(parts.next()?);
        let tint = u32::from_str_radix(parts.next()?, 16).ok()?;
        Some(Spec { source: parts.next()?.to_string(), stretch, uv, tint })
    }

    /// Natural size: the `uv` region's, else the source's.
    fn natural_size(&self) -> (f32, f32) {
        match self.uv {
            Some([_, _, w, h]) => (w, h),
            None => source_size(&self.source),
        }
    }
}

/// The widget for an `<Image>` (sized to its natural size until laid out).
pub fn widget(node: &YuiNode) -> Widget {
    let spec = Spec::of(node);
    let (w, h) = spec.natural_size();
    yog_ui::widget::mc_image(spec.encode(), w, h)
}

/// Sets each image's drawn size to its laid-out content box.
pub fn fit_to_layout(w: &mut Widget, l: &LayoutNode) {
    if let WidgetKind::McImage { id, img_w, img_h } = &mut w.kind
        && id.starts_with(PREFIX)
    {
        let p = w.style.pad;
        *img_w = (l.rect.w - p[1] - p[3]).max(0.0);
        *img_h = (l.rect.h - p[0] - p[2]).max(0.0);
    }
    for (cw, cl) in w.children.iter_mut().zip(&l.children) {
        fit_to_layout(cw, cl);
    }
}

/// A source with `mod:` filled in from the document's mod id.
fn resolve(source: &str) -> Option<ImageSource> {
    let parsed = ImageSource::parse(source)?;
    match parsed {
        ImageSource::ModPath(path) => {
            let id = with_doc(|d| d.and_then(|d| d.mod_id.clone()))?;
            Some(ImageSource::ModPath(path).with_mod_id(&id))
        }
        other => Some(other),
    }
}

fn texture(id: &str) -> Option<Arc<Image>> {
    with_doc(|d| d.and_then(|d| d.res.texture(id)))
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
    let blocks = ["", "_front", "_side", "_top"].map(|s| format!("{ns}:textures/block/{name}{s}.png"));
    let mut order: Vec<&String> = blocks.iter().collect();
    if block {
        order.push(&item);
    } else {
        order.insert(0, &item);
    }
    order.into_iter().find_map(|t| texture(t))
}

/// Natural size of `source` in GUI pixels.
pub fn source_size(source: &str) -> (f32, f32) {
    match resolve(source) {
        Some(ImageSource::Sprite(name)) => yi::sprite(&name).map_or((16.0, 16.0), |s| s.size(has_atlas())),
        Some(ImageSource::Texture(id)) => texture(&id).map_or((16.0, 16.0), |i| (i.w as f32, i.h as f32)),
        _ => (16.0, 16.0),
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
    c.blit(img, x, y, w, h, [u / iw, v / ih, (u + uw) / iw, (v + vh) / ih], tint(t));
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
    let cols = [(x, b, u, b), (x + b, w - 2.0 * b, u + b, rw - 2.0 * b), (x + w - b, b, u + rw - b, b)];
    let rows = [(y, b, v, b), (y + b, h - 2.0 * b, v + b, rh - 2.0 * b), (y + h - b, b, v + rh - b, b)];
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
        nine_slice(c, &img, [0.0, 0.0, img.w as f32, img.h.min(img.w.max(1) * 64) as f32], sp.border, dest, t);
        return;
    }
    if let Some(LegacyRegion { texture: tex, u, v, w, h, tex_w, .. }) = sp.legacy
        && let Some(img) = texture(tex)
    {
        // Resource packs may ship the sheet at a higher resolution.
        let k = img.w as f32 / tex_w;
        nine_slice(c, &img, [u * k, v * k, w * k, h * k], sp.border * k, dest, t);
        return;
    }
    missing(c, dest);
}

fn missing(c: &mut Canvas, dest: [f32; 4]) {
    blit_px(c, &Image::missing(), dest, [0.0, 0.0, 16.0, 16.0], 0xFFFF_FFFF);
}

/// Draws an `<Image>` into its content box `x, y, w, h`.
pub fn draw(c: &mut Canvas, spec: &Spec, x: f32, y: f32, w: f32, h: f32) {
    let source = resolve(&spec.source);
    let whole = matches!(source, Some(ImageSource::Item(_) | ImageSource::Block(_) | ImageSource::Sprite(_)));
    let stretch = match spec.stretch {
        Stretch::UniformToFill if whole => Stretch::Uniform,
        s => s,
    };
    let (nw, nh) = spec.natural_size();
    let ([dx, dy, dw, dh], [u0, v0, u1, v1]) = fit(stretch, nw, nh, x, y, w, h);
    let dest = [dx, dy, dw, dh];
    if dw <= 0.0 || dh <= 0.0 {
        return;
    }
    match source {
        Some(ImageSource::Item(id)) => match item_texture(&id, false) {
            Some(img) => blit_px(c, &img, dest, [0.0, 0.0, img.w as f32, img.w.min(img.h) as f32], spec.tint),
            None => missing(c, dest),
        },
        Some(ImageSource::Block(id)) => match item_texture(&id, true) {
            Some(img) => blit_px(c, &img, dest, [0.0, 0.0, img.w as f32, img.w.min(img.h) as f32], spec.tint),
            None => missing(c, dest),
        },
        Some(ImageSource::Sprite(name)) => match yi::sprite(&name) {
            Some(sp) => sprite(c, sp, dest, spec.tint),
            None => match name.split_once(':').and_then(|(ns, p)| texture(&format!("{ns}:textures/gui/sprites/{p}.png"))) {
                Some(img) => blit_px(c, &img, dest, [0.0, 0.0, img.w as f32, img.h as f32], spec.tint),
                None => missing(c, dest),
            },
        },
        Some(ImageSource::Texture(id)) => match texture(&id) {
            Some(img) => {
                let [ru, rv, rw, rh] = spec.uv.unwrap_or([0.0, 0.0, img.w as f32, img.h as f32]);
                let src = [ru + u0 * rw, rv + v0 * rh, (u1 - u0) * rw, (v1 - v0) * rh];
                blit_px(c, &img, dest, src, spec.tint);
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
    let Ok(entries) = std::fs::read_dir(dir) else { return };
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
        for base in [root.join("assets"), root.join("src/assets"), root.join("resources/assets")] {
            pngs(&base.join(&id).join("textures"), "", &mut own);
        }
        own.sort();
        own.dedup();
        out.extend(own.into_iter().map(|p| Candidate { source: format!("mod:{p}"), group: "mod".into(), detail: format!("assets/{id}/textures/{p}.png") }));
    }
    out.extend(yi::SPRITES.iter().map(|s| Candidate {
        source: format!("sprite:{}", s.name),
        group: "sprite".into(),
        detail: format!("{} ({}×{})", s.description, s.w, s.h),
    }));
    let res = Resources::for_mod(root.as_deref());
    if let Some(v) = &res.vanilla {
        let (items, blocks) = v.texture_names();
        out.extend(items.into_iter().map(|n| Candidate { source: format!("item:{n}"), group: "item".into(), detail: String::new() }));
        out.extend(blocks.into_iter().map(|n| Candidate { source: format!("block:{n}"), group: "block".into(), detail: String::new() }));
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
    let spec = Spec { source: source.to_string(), stretch: Stretch::Uniform, uv: None, tint: 0xFFFF_FFFF };
    draw(&mut c, &spec, 0.0, 0.0, size as f32, size as f32);
    let png = c.png().ok()?;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_round_trip() {
        let spec = Spec { source: "item:apple".into(), stretch: Stretch::Fill, uv: Some([1.0, 2.0, 3.0, 4.0]), tint: 0x80FF_0000 };
        assert_eq!(Spec::decode(&spec.encode()), Some(spec));
        assert_eq!(stretch("UniformToFill"), Stretch::UniformToFill);
        assert_eq!(stretch("bogus"), Stretch::Uniform);
    }

    /// `YOG_IMAGES_PNG=out.png cargo test --lib designer::images -- --ignored`:
    /// every kind of source drawn with the local game files, for eyeballing.
    #[test]
    #[ignore]
    fn sample_png() {
        use base64::Engine as _;
        let Ok(out) = std::env::var("YOG_IMAGES_PNG") else { return };
        let n = |uid: &str, attrs: &[(&str, &str)]| YuiNode {
            uid: uid.into(),
            kind: "Image".into(),
            attrs: attrs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            children: vec![],
        };
        let mut root = n("s", &[("width", "200"), ("height", "120"), ("bg", "#C0101010")]);
        root.kind = "Screen".into();
        root.children = vec![
            // The reported case: a raw path, w/h larger than the texture.
            n("a", &[("x", "4"), ("y", "4"), ("w", "156"), ("h", "29"), ("texture", "minecraft:textures/item/apple.png"), ("tex_w", "16"), ("tex_h", "16"), ("bg", "#40FFFFFF")]),
            n("b", &[("x", "4"), ("y", "36"), ("w", "32"), ("h", "32"), ("source", "item:apple")]),
            n("c", &[("x", "40"), ("y", "36"), ("w", "32"), ("h", "32"), ("source", "block:crafting_table")]),
            n("d", &[("x", "76"), ("y", "36"), ("w", "100"), ("h", "20"), ("source", "sprite:button"), ("stretch", "Fill")]),
            n("e", &[("x", "76"), ("y", "60"), ("source", "sprite:icon/heart")]),
            n("f", &[("x", "90"), ("y", "60"), ("source", "sprite:slot")]),
            n("g", &[("x", "4"), ("y", "72"), ("w", "64"), ("h", "40"), ("source", "item:diamond"), ("stretch", "Fill"), ("tint", "#FF80FF80")]),
        ];
        let args = super::super::RenderArgs { path: "/nowhere/src/x.yui".into(), root, screen_w: 200, screen_h: 120, scale: 4, preview: false };
        let r = super::super::render(&args).unwrap();
        let b64 = r.image.trim_start_matches("data:image/png;base64,");
        std::fs::write(out, base64::engine::general_purpose::STANDARD.decode(b64).unwrap()).unwrap();
        eprintln!("assets: {:?}", r.assets);
    }
}
