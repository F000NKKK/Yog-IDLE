//! The `.yui` screen designer's backend: the canvas drawn by yog-ui itself
//! (the crate mods render with in game) through a recording `YogGfxApi`,
//! rasterized with Minecraft's own font and textures from the local game
//! files; a preview mode driving the same tree with real UI events
//! (`click:X:Y`, `scroll:DY`, scrollbar drags); and code-behind handlers.

pub mod assets;
pub mod codebehind;
pub mod font;
pub mod gfx;
pub mod images;
pub mod markup;
pub mod raster;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use yog_ui::layout::LayoutNode;
use yog_ui::{ScrollState, UiRoot, Widget};

use self::assets::Resources;
use self::markup::YuiNode;

/// A laid-out widget: its border box and its content box (inside padding), GUI px.
#[derive(Debug, Clone, Serialize)]
pub struct NodeRect {
    pub uid: String,
    pub rect: [f32; 4],
    pub content: [f32; 4],
}

/// Where the game resources came from (`None`: no client jar found).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetsInfo {
    pub version: String,
    pub jar: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rendered {
    /// `data:image/png;base64,…` — `scale` physical px per GUI px.
    pub image: String,
    pub scale: u32,
    pub rects: Vec<NodeRect>,
    pub assets: Option<AssetsInfo>,
    /// Text uses the game's font (else a stand-in glyph box).
    pub real_font: bool,
}

/// The mod a `.yui` belongs to: the folder holding the `src/` it's in.
pub(crate) fn mod_root(yui: &Path) -> Option<PathBuf> {
    yui.ancestors().find(|p| p.file_name().is_some_and(|n| n == "src")).and_then(|p| p.parent()).map(Path::to_path_buf)
}

/// Built and laid out like the generated `root_with`.
type Laid = UiRoot;

fn lay_out(root: &YuiNode, screen_w: f32, screen_h: f32, scroll: &HashMap<String, f32>) -> Laid {
    let mut ui = UiRoot::new("yog-idle:designer", markup::screen(root, screen_w, screen_h, scroll));
    // Text widths and image sizes come from the "host" — the designer's own
    // font and image resolution — as they do from the game in `UiRoot::render`.
    let table = gfx::api(screen_w as i32, screen_h as i32, 1.0);
    // SAFETY: every function in `table` is sound to call; only fn pointers are kept.
    let ctx = unsafe { yog_gfx::GfxContext::from_raw(&table) };
    yog_ui::text::use_host_metrics(&ctx);
    yog_ui::image::use_host_images(&ctx);
    ui.layout(screen_w, screen_h);
    ui
}

/// Pairs each `.yui` node with its widget and layout node (the screen's
/// wrapper skipped; a `TextBox`'s inner parts aren't elements).
fn walk<'a>(node: &'a YuiNode, w: &'a Widget, l: &'a LayoutNode, visit: &mut impl FnMut(&'a YuiNode, &'a Widget, &'a LayoutNode)) {
    visit(node, w, l);
    if !markup::is_container(&node.kind) {
        return;
    }
    for (i, child) in node.children.iter().enumerate() {
        if let (Some(cw), Some(cl)) = (w.children.get(i), l.children.get(i)) {
            walk(child, cw, cl, visit);
        }
    }
}

fn with_content<'a>(root: &'a YuiNode, laid: &'a Laid, mut visit: impl FnMut(&'a YuiNode, &'a Widget, &'a LayoutNode)) {
    if let (Some(w), Some(l)) = (laid.root.children.first(), laid.layout_root.children.first()) {
        walk(root, w, l, &mut visit);
    }
}

fn rects(root: &YuiNode, laid: &Laid) -> Vec<NodeRect> {
    let mut out = Vec::new();
    with_content(root, laid, |n, w, l| {
        let r = l.rect;
        let p = w.style.pad;
        out.push(NodeRect {
            uid: n.uid.clone(),
            rect: [r.x, r.y, r.w, r.h],
            content: [r.x + p[3], r.y + p[0], (r.w - p[1] - p[3]).max(0.0), (r.h - p[0] - p[2]).max(0.0)],
        });
    });
    out
}

/// Per-file preview state: the scroll views' offsets/drags.
#[derive(Default)]
struct Preview {
    scroll: HashMap<String, ScrollState>,
}

fn previews() -> &'static Mutex<HashMap<String, Preview>> {
    static P: OnceLock<Mutex<HashMap<String, Preview>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

fn offsets(path: &str, preview: bool) -> HashMap<String, f32> {
    if !preview {
        return HashMap::new();
    }
    let p = previews().lock().unwrap_or_else(|e| e.into_inner());
    p.get(path).map(|s| s.scroll.iter().map(|(k, v)| (k.clone(), v.offset)).collect()).unwrap_or_default()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderArgs {
    pub path: String,
    pub root: YuiNode,
    pub screen_w: u32,
    pub screen_h: u32,
    pub scale: u32,
    #[serde(default)]
    pub preview: bool,
}

pub fn render(args: &RenderArgs) -> Result<Rendered, String> {
    let (sw, sh) = (args.screen_w.clamp(1, 4096), args.screen_h.clamp(1, 4096));
    let scroll = offsets(&args.path, args.preview);
    images::set_document(mod_root(Path::new(&args.path)).as_deref());
    let laid = lay_out(&args.root, sw as f32, sh as f32, &scroll);
    let ops = gfx::record(sw as i32, sh as i32, |ctx| laid.render(ctx));
    let res = Resources::for_mod(mod_root(Path::new(&args.path)).as_deref());
    let scale = args.scale.clamp(1, 8);
    let canvas = raster::rasterize(&ops, sw, sh, scale, &res);
    let real_font = res.vanilla.is_some() || canvas_font_real(&res);
    let png = canvas.png()?;
    Ok(Rendered {
        image: format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)),
        scale,
        rects: rects(&args.root, &laid),
        assets: res.vanilla.as_ref().map(|v| AssetsInfo { version: v.version.clone(), jar: v.jar.to_string_lossy().into_owned() }),
        real_font,
    })
}

fn canvas_font_real(res: &Resources) -> bool {
    font::Font::load(res, "minecraft:default").is_real()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventArgs {
    pub path: String,
    pub root: YuiNode,
    pub screen_w: u32,
    pub screen_h: u32,
    /// A Yog UI event: `click:X:Y`, `drag:X:Y`, `release:X:Y`, `scroll:DY`, `move:X:Y` (hover only).
    pub event: String,
    /// The cursor, for the wheel (which carries no position).
    #[serde(default)]
    pub x: f32,
    #[serde(default)]
    pub y: f32,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventResult {
    /// A scroll view used the event (wheel, scrollbar).
    pub scrolled: bool,
    /// The clickable element under the cursor (`hit_test`: deepest enabled with `on_click`).
    pub hit: Option<String>,
    /// Its `on_click`, for a click.
    pub clicked: Option<String>,
}

/// `hit_test` (yog-ui `layout::hit_test`), answering with the `.yui` uid.
fn hit<'a>(node: &'a YuiNode, l: &'a LayoutNode, mx: f32, my: f32) -> Option<&'a YuiNode> {
    if !l.rect.contains(mx, my) {
        return None;
    }
    if markup::is_container(&node.kind) {
        for (i, child) in node.children.iter().enumerate().rev() {
            if let Some(found) = l.children.get(i).and_then(|cl| hit(child, cl, mx, my)) {
                return Some(found);
            }
        }
    }
    (l.on_click.is_some() && l.enabled).then_some(node)
}

fn xy(rest: &str) -> Option<(f32, f32)> {
    let mut it = rest.split(':');
    Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
}

pub fn event(args: &EventArgs) -> EventResult {
    let (sw, sh) = (args.screen_w.clamp(1, 4096) as f32, args.screen_h.clamp(1, 4096) as f32);
    let scroll = offsets(&args.path, true);
    let laid = lay_out(&args.root, sw, sh, &scroll);
    let mut out = EventResult::default();
    let pos = args.event.split_once(':').and_then(|(_, rest)| xy(rest)).unwrap_or((args.x, args.y));

    // Scroll views first, as a screen's code-behind does (`ScrollState::handle`).
    if !args.event.starts_with("move:") {
        let mut views: Vec<(&YuiNode, &LayoutNode)> = Vec::new();
        with_content(&args.root, &laid, |n, _, l| {
            if n.kind == "ScrollView" {
                views.push((n, l));
            }
        });
        let mut all = previews().lock().unwrap_or_else(|e| e.into_inner());
        let state = all.entry(args.path.clone()).or_default();
        let wheel = args.event.starts_with("scroll:");
        // The wheel goes to the innermost view under the cursor; the rest to every view (each checks its own scrollbar).
        for (n, l) in views.iter().rev() {
            if wheel && !l.rect.contains(pos.0, pos.1) {
                continue;
            }
            let s = state.scroll.entry(n.uid.clone()).or_default();
            if s.handle(&args.event, l, 24.0) {
                out.scrolled = true;
                break;
            }
        }
    }
    if let Some(l) = laid.layout_root.children.first() {
        let found = hit(&args.root, l, pos.0, pos.1);
        out.hit = found.map(|n| n.uid.clone());
        if args.event.starts_with("click:") && !out.scrolled {
            out.clicked = found.and_then(|n| n.attr("on_click")).map(str::to_string);
        }
    }
    out
}

/// Forgets a file's preview state (scroll positions).
pub fn reset(path: &str) {
    previews().lock().unwrap_or_else(|e| e.into_inner()).remove(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(uid: &str, kind: &str, attrs: &[(&str, &str)], children: Vec<YuiNode>) -> YuiNode {
        YuiNode { uid: uid.into(), kind: kind.into(), attrs: attrs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), children }
    }

    fn screen() -> YuiNode {
        node(
            "s",
            "Screen",
            &[("id", "m:s"), ("width", "100"), ("height", "60"), ("bg", "#FF101010")],
            vec![
                node("b", "Button", &[("x", "10"), ("y", "10"), ("w", "40"), ("h", "20"), ("text", "Play"), ("on_click", "play")], vec![]),
                node(
                    "sv",
                    "ScrollView",
                    &[("x", "60"), ("y", "0"), ("w", "30"), ("h", "30")],
                    (0..10).map(|i| node(&format!("r{i}"), "Spacer", &[("w", "20"), ("h", "10")], vec![])).collect(),
                ),
            ],
        )
    }

    #[test]
    fn rects_come_from_yog_ui_layout() {
        let laid = lay_out(&screen(), 200.0, 100.0, &HashMap::new());
        let r = rects(&screen(), &laid);
        // Centered: ((200 - 100) / 2, (100 - 60) / 2).
        assert_eq!(r[0].uid, "s");
        assert_eq!(r[0].rect, [50.0, 20.0, 100.0, 60.0]);
        let b = r.iter().find(|n| n.uid == "b").unwrap();
        assert_eq!(b.rect, [60.0, 30.0, 40.0, 20.0]);
    }

    #[test]
    fn renders_through_the_recorder() {
        let args = RenderArgs { path: "/nowhere/src/x.yui".into(), root: screen(), screen_w: 200, screen_h: 100, scale: 2, preview: false };
        let laid = lay_out(&args.root, 200.0, 100.0, &HashMap::new());
        let ops = gfx::record(200, 100, |ctx| laid.render(ctx));
        assert!(matches!(ops.first(), Some(DrawOp::Rect { color: 0xFF10_1010, .. })), "{ops:?}");
        assert!(ops.iter().any(|o| matches!(o, DrawOp::Text { text, .. } if text == "Play")));
        let out = render(&args).unwrap();
        assert!(out.image.starts_with("data:image/png;base64,"));
        assert_eq!(out.rects.len(), 13);
    }

    #[test]
    fn preview_clicks_and_scrolls() {
        let path = "/nowhere/src/preview_test.yui";
        let ev = |e: &str, x: f32, y: f32| event(&EventArgs { path: path.into(), root: screen(), screen_w: 200, screen_h: 100, event: e.into(), x, y });
        let r = ev("click:70:40", 0.0, 0.0);
        assert_eq!(r.clicked.as_deref(), Some("play"));
        assert_eq!(r.hit.as_deref(), Some("b"));
        assert!(ev("click:5:5", 0.0, 0.0).clicked.is_none());
        let r = ev("scroll:-1", 120.0, 30.0);
        assert!(r.scrolled);
        assert!(offsets(path, true)["sv"] > 0.0);
        reset(path);
        assert!(offsets(path, true).is_empty());
    }
}

#[cfg(test)]
mod visual {
    use super::*;

    /// `YOG_DESIGNER_PNG=out.png cargo test --lib designer::visual -- --ignored`:
    /// a sample screen drawn with the local game files, for eyeballing.
    #[test]
    #[ignore]
    fn sample_png() {
        let Ok(out) = std::env::var("YOG_DESIGNER_PNG") else { return };
        let n = |uid: &str, kind: &str, attrs: &[(&str, &str)]| YuiNode {
            uid: uid.into(),
            kind: kind.into(),
            attrs: attrs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            children: vec![],
        };
        let mut root = n("s", "Screen", &[("width", "200"), ("height", "120"), ("bg", "#C0101010")]);
        root.children = vec![
            n("l", "Label", &[("x", "6"), ("y", "6"), ("text", "Привет, Minecraft! §cRed §lBold"), ("color", "#FFFFFF"), ("no_wrap", "true")]),
            n("b", "Button", &[("x", "6"), ("y", "24"), ("w", "80"), ("h", "20"), ("text", "Play"), ("bg", "#FF555555"), ("color", "#FFFFFF")]),
            n("t", "TextBox", &[("x", "96"), ("y", "26"), ("w", "90"), ("h", "16"), ("placeholder", "Search…")]),
            n("i", "InvSlot", &[("x", "6"), ("y", "50"), ("item", "minecraft:diamond"), ("count", "64")]),
            n("g", "Label", &[("x", "6"), ("y", "76"), ("text", "Galactic"), ("font", "minecraft:alt"), ("no_wrap", "true")]),
            n("u", "Label", &[("x", "6"), ("y", "90"), ("text", "日本語 ✓ ♥"), ("no_wrap", "true")]),
        ];
        let args = RenderArgs { path: "/nowhere/src/x.yui".into(), root, screen_w: 220, screen_h: 130, scale: 4, preview: false };
        let r = render(&args).unwrap();
        let b64 = r.image.trim_start_matches("data:image/png;base64,");
        std::fs::write(out, base64::engine::general_purpose::STANDARD.decode(b64).unwrap()).unwrap();
        eprintln!("assets: {:?}, real font: {}", r.assets, r.real_font);
    }
}
