//! A `.yui` tree (as the designer holds it) → the `yog_ui::Widget` tree the
//! generated `*.designer.rs` builds in game — the same builder calls `yog
//! build` emits (yog-cli `yui.rs`), made directly instead of as source —
//! wrapped like the generated `root_with` (the screen panel, anchored).

use std::collections::HashMap;

use serde::Deserialize;
use yog_ui::widget::{self, Widget};
use yog_ui::{Align, Dock, FlexDir, FocusStyle, Units};

/// One element of the designer's document (`YuiNode` in `yui.ts`).
#[derive(Debug, Clone, Deserialize)]
pub struct YuiNode {
    pub uid: String,
    pub kind: String,
    #[serde(default)]
    pub attrs: HashMap<String, String>,
    #[serde(default)]
    pub children: Vec<YuiNode>,
}

impl YuiNode {
    pub fn attr(&self, key: &str) -> Option<&str> {
        self.attrs.get(key).map(String::as_str)
    }
}

const CONTAINERS: &[&str] = &["Screen", "Canvas", "Column", "Row", "ScrollView"];

pub fn is_container(kind: &str) -> bool {
    CONTAINERS.contains(&kind)
}

fn num(v: Option<&str>) -> Option<f32> {
    v?.trim().parse().ok()
}

/// `#RRGGBB`, `#AARRGGBB` or `0xAARRGGBB` (yog-cli's `color`).
pub fn color(value: &str) -> Option<u32> {
    let v = value.trim();
    let hex = v.strip_prefix('#').or_else(|| v.strip_prefix("0x")).or_else(|| v.strip_prefix("0X"))?.replace('_', "");
    let n = u32::from_str_radix(&hex, 16).ok()?;
    match hex.len() {
        6 => Some(0xFF00_0000 | n),
        8 => Some(n),
        _ => None,
    }
}

fn size(v: &str) -> Option<Units> {
    let v = v.trim();
    if v.is_empty() || v == "auto" {
        return None;
    }
    if let Some(p) = v.strip_suffix('%') {
        return p.trim().parse().ok().map(Units::Percent);
    }
    v.parse().ok().map(Units::Px)
}

fn padding(v: &str) -> Option<[f32; 4]> {
    let parts: Vec<f32> = v.split([' ', ',']).filter(|s| !s.is_empty()).map(|s| s.parse().ok()).collect::<Option<_>>()?;
    match parts.as_slice() {
        [a] => Some([*a; 4]),
        [v, h] => Some([*v, *h, *v, *h]),
        [t, r, b, l] => Some([*t, *r, *b, *l]),
        _ => None,
    }
}

/// What a text attribute shows: `@key` is a translation key (shown as the
/// key — the designer has no game language), `@@x` the literal `@x`.
pub fn text(value: Option<&str>) -> String {
    let v = value.unwrap_or_default();
    match v.strip_prefix('@') {
        Some(rest) if rest.starts_with('@') => rest.to_string(),
        _ => v.to_string(),
    }
}

/// Builds the widget for `node`. `in_canvas`: the parent places children
/// absolutely. `scroll`: preview scroll offsets by uid.
pub fn widget(node: &YuiNode, in_canvas: bool, scroll: &HashMap<String, f32>) -> Widget {
    let a = |k: &str| node.attr(k);
    let mut w = match node.kind.as_str() {
        "Screen" | "Canvas" | "Column" => widget::panel(FlexDir::Column),
        "Row" => widget::panel(FlexDir::Row),
        "ScrollView" => widget::scroll_view(),
        "Label" => widget::label(text(a("text"))),
        "Button" => widget::button(text(a("text"))),
        "ItemSlot" => widget::item_slot(a("item").unwrap_or_default()),
        "InvSlot" => widget::inv_slot(a("item").unwrap_or_default(), a("count").and_then(|c| c.trim().parse().ok()).unwrap_or(1)),
        "Image" => widget::mc_image(a("texture").unwrap_or_default(), num(a("tex_w")).unwrap_or(16.0), num(a("tex_h")).unwrap_or(16.0)),
        "TextBox" => text_box(node),
        _ => widget::spacer(),
    };
    if node.kind == "Screen" {
        if let Some(v) = num(a("width")) {
            w = w.w(Units::Px(v));
        }
        if let Some(v) = num(a("height")) {
            w = w.h(Units::Px(v));
        }
    }
    let (x, y) = (num(a("x")), num(a("y")));
    if in_canvas || x.is_some() || y.is_some() {
        w = w.at(x.unwrap_or(0.0), y.unwrap_or(0.0));
    }
    // Attribute order doesn't matter for these builder calls but follows the file's, like the generator.
    let mut keys: Vec<&String> = node.attrs.keys().collect();
    keys.sort();
    for key in keys {
        let v = node.attrs[key].as_str();
        w = match key.as_str() {
            "id" if node.kind != "Screen" => w.id(v),
            "on_click" => w.on_click(v),
            "w" => size(v).map_or(w.clone(), |s| w.clone().w(s)),
            "h" => size(v).map_or(w.clone(), |s| w.clone().h(s)),
            "min_w" => num(Some(v)).map_or(w.clone(), |n| w.clone().min_w(n)),
            "min_h" => num(Some(v)).map_or(w.clone(), |n| w.clone().min_h(n)),
            "flex" => num(Some(v)).map_or(w.clone(), |n| w.clone().flex(n)),
            "gap" => num(Some(v)).map_or(w.clone(), |n| w.clone().gap(n)),
            "font_scale" => num(Some(v)).map_or(w.clone(), |n| w.clone().font_scale(n)),
            "dock" => w.dock(match v.trim() {
                "fill" => Dock::Fill,
                "left" => Dock::Left,
                "right" => Dock::Right,
                "top" => Dock::Top,
                "bottom" => Dock::Bottom,
                _ => Dock::None,
            }),
            "align" => w.align(match v.trim() {
                "center" => Align::Center,
                "end" => Align::End,
                _ => Align::Start,
            }),
            "focus_style" => w.focus_style(match v.trim() {
                "fill" => FocusStyle::Fill,
                "none" => FocusStyle::None,
                _ => FocusStyle::Outline,
            }),
            "padding" => padding(v).map_or(w.clone(), |[t, r, b, l]| w.clone().padding(t, r, b, l)),
            "bg" if node.kind != "TextBox" => color(v).map_or(w.clone(), |c| w.clone().bg(c)),
            "color" if node.kind != "TextBox" => color(v).map_or(w.clone(), |c| w.clone().color(c)),
            "focus_color" => color(v).map_or(w.clone(), |c| w.clone().focus_color(c)),
            "shadow" if node.kind != "TextBox" => w.shadow(v.trim() == "true"),
            "enabled" => w.enabled(v.trim() != "false"),
            "no_wrap" if v.trim() == "true" => w.no_wrap(),
            "ellipsis" if v.trim() == "true" => w.ellipsis(),
            _ => w,
        };
    }
    if node.kind == "ScrollView"
        && let Some(offset) = scroll.get(&node.uid) {
            w = w.scroll_y(*offset);
        }
    if is_container(&node.kind) {
        let canvas = matches!(node.kind.as_str(), "Screen" | "Canvas");
        for child in &node.children {
            w = w.child(widget(child, canvas, scroll));
        }
    }
    w
}

/// `TextBox` isn't in the published yog-ui yet: drawn like Minecraft's edit
/// box (grey frame, black field, the text or a grey placeholder) out of
/// stock widgets until it is.
fn text_box(node: &YuiNode) -> Widget {
    let value = text(node.attr("text"));
    let (shown, fg) = if value.is_empty() {
        (text(node.attr("placeholder")), 0xFF_707070)
    } else {
        (value, node.attr("color").and_then(color).unwrap_or(0xFF_E0E0E0))
    };
    let field = widget::label(shown)
        .w(Units::Percent(100.0))
        .h(Units::Percent(100.0))
        .bg(node.attr("bg").and_then(color).unwrap_or(0xFF_000000))
        .color(fg)
        .shadow(node.attr("shadow").is_none_or(|s| s.trim() != "false"))
        .no_wrap()
        .ellipsis()
        .padding(0.0, 3.0, 0.0, 4.0);
    widget::panel(FlexDir::Column).bg(0xFF_A0A0A0).padding(1.0, 1.0, 1.0, 1.0).gap(0.0).child(field)
}

/// The anchored screen (`root_with`): a `screen_w × screen_h` panel with the
/// content placed per `anchor`.
pub fn screen(root: &YuiNode, screen_w: f32, screen_h: f32, scroll: &HashMap<String, f32>) -> Widget {
    let width = num(root.attr("width")).unwrap_or(176.0);
    let height = num(root.attr("height")).unwrap_or(166.0);
    let content = widget(root, false, scroll);
    let cx = ((screen_w - width) / 2.0).floor();
    let cy = ((screen_h - height) / 2.0).floor();
    let anchor = root.attr("anchor").unwrap_or("center").trim();
    let content = if anchor == "fill" {
        content.w(Units::Percent(100.0)).h(Units::Percent(100.0)).at(0.0, 0.0)
    } else {
        let (ax, ay) = match anchor {
            "top_left" => (0.0, 0.0),
            "top" => (cx, 0.0),
            "top_right" => (screen_w - width, 0.0),
            "left" => (0.0, cy),
            "right" => (screen_w - width, cy),
            "bottom_left" => (0.0, screen_h - height),
            "bottom" => (cx, screen_h - height),
            "bottom_right" => (screen_w - width, screen_h - height),
            _ => (cx, cy),
        };
        content.at(ax.max(0.0), ay.max(0.0))
    };
    widget::panel(FlexDir::Column).w(Units::Px(screen_w)).h(Units::Px(screen_h)).child(content)
}
