//! A `.yui` tree (as the designer holds it) → the `yog_ui::Widget` tree the
//! generated `.g.rs` builds in game — the same builder calls `yog
//! build` emits (yog-cli `yui.rs`), made directly instead of as source —
//! wrapped like the generated `root_with` (the screen panel, anchored).

use std::collections::HashMap;

use serde::Deserialize;
use yog_ui::widget::{self, Widget};
use yog_ui::{Align, Dock, FlexDir, FocusStyle, HAlign, Track, Units, VAlign};

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

const CONTAINERS: &[&str] = &["Screen", "Canvas", "Column", "Row", "ScrollView", "Grid"];

pub fn is_container(kind: &str) -> bool {
    CONTAINERS.contains(&kind)
}

/// A property element (`<Grid.RowDefinitions>`) — part of its parent, not a widget.
pub fn is_property_element(node: &YuiNode) -> bool {
    node.kind.contains('.')
}

/// The children that are widgets (property elements skipped).
pub fn widget_children(node: &YuiNode) -> impl Iterator<Item = &YuiNode> {
    node.children.iter().filter(|c| !is_property_element(c))
}

/// One row/column size: `Auto`, `*`, `2*`, `26` (yog-cli's `yui_grid`).
fn track(v: &str) -> Option<Track> {
    let v = v.trim();
    if v.eq_ignore_ascii_case("auto") {
        return Some(Track::auto());
    }
    if let Some(w) = v.strip_suffix('*') {
        let w = if w.trim().is_empty() {
            1.0
        } else {
            w.trim().parse().ok()?
        };
        return Some(Track::star(w));
    }
    v.parse().ok().map(Track::px)
}

/// A grid's rows (`row`) or columns: `rows="Auto,*"` or `<Grid.RowDefinitions>`.
/// Sizes it can't read count as `*`, so the canvas still draws while typing.
fn tracks(node: &YuiNode, row: bool) -> Option<Vec<Track>> {
    let (attr, prop, size, min, max) = if row {
        (
            "rows",
            "Grid.RowDefinitions",
            "height",
            "min_height",
            "max_height",
        )
    } else {
        (
            "columns",
            "Grid.ColumnDefinitions",
            "width",
            "min_width",
            "max_width",
        )
    };
    if let Some(v) = node.attr(attr) {
        return Some(
            v.split(',')
                .map(|p| track(p).unwrap_or(Track::star(1.0)))
                .collect(),
        );
    }
    let defs = node.children.iter().find(|c| c.kind == prop)?;
    Some(
        defs.children
            .iter()
            .map(|d| {
                let mut t = track(d.attr(size).unwrap_or("*")).unwrap_or(Track::star(1.0));
                if let Some(n) = num(d.attr(min)) {
                    t = t.min(n);
                }
                if let Some(n) = num(d.attr(max)) {
                    t = t.max(n);
                }
                t
            })
            .collect(),
    )
}

fn cell_index(v: Option<&str>) -> Option<u16> {
    v?.trim().parse().ok()
}

fn num(v: Option<&str>) -> Option<f32> {
    v?.trim().parse().ok()
}

/// `#RRGGBB`, `#AARRGGBB` or `0xAARRGGBB` (yog-cli's `color`).
pub fn color(value: &str) -> Option<u32> {
    let v = value.trim();
    let hex = v
        .strip_prefix('#')
        .or_else(|| v.strip_prefix("0x"))
        .or_else(|| v.strip_prefix("0X"))?
        .replace('_', "");
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
    let parts: Vec<f32> = v
        .split([' ', ','])
        .filter(|s| !s.is_empty())
        .map(|s| s.parse().ok())
        .collect::<Option<_>>()?;
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

/// `<Screen theme>`'s defaults on every node that doesn't set the attribute
/// itself — as `yog build` applies them.
pub fn apply_theme(root: &mut YuiNode) {
    let Some(theme) = root.attr("theme").and_then(yog_ui::theme::Theme::builtin) else {
        return;
    };
    fn walk(n: &mut YuiNode, theme: &yog_ui::theme::Theme) {
        for (k, v) in theme.attrs(&n.kind) {
            n.attrs.entry(k.clone()).or_insert_with(|| v.clone());
        }
        for c in &mut n.children {
            walk(c, theme);
        }
    }
    walk(root, &theme);
}

/// Builds the widget for `node`. `in_canvas`: the parent places children
/// absolutely. `scroll`: preview scroll offsets by uid.
pub fn widget(node: &YuiNode, in_canvas: bool, scroll: &HashMap<String, f32>) -> Widget {
    let a = |k: &str| node.attr(k);
    let mut w = match node.kind.as_str() {
        "Screen" | "Canvas" | "Column" => widget::panel(FlexDir::Column),
        "Row" => widget::panel(FlexDir::Row),
        "Grid" => widget::grid(),
        "ScrollView" => widget::scroll_view(),
        "Label" => widget::label(text(a("text"))),
        "Button" => widget::button(text(a("text"))),
        "ItemSlot" => widget::item_slot(a("item").unwrap_or_default()),
        "InvSlot" => widget::inv_slot(
            a("item").unwrap_or_default(),
            a("count").and_then(|c| c.trim().parse().ok()).unwrap_or(1),
        ),
        "Slot" => widget::slot(a("index").and_then(|i| i.trim().parse().ok()).unwrap_or(0)),
        "PlayerInventory" => widget::player_inventory(),
        "Image" => super::images::widget(node),
        "TextBox" => widget::text_box(text(a("text"))),
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
    if node.kind == "Grid" {
        if let Some(rows) = tracks(node, true) {
            w = w.rows(rows);
        }
        if let Some(cols) = tracks(node, false) {
            w = w.cols(cols);
        }
        if let Some(n) = num(a("row_spacing")) {
            w = w.row_spacing(n);
        }
        if let Some(n) = num(a("column_spacing")) {
            w = w.col_spacing(n);
        }
    }
    let (row, col) = (cell_index(a("Grid.Row")), cell_index(a("Grid.Column")));
    if row.is_some() || col.is_some() {
        w = w.cell(row.unwrap_or(0), col.unwrap_or(0));
    }
    let (rs, cs) = (
        cell_index(a("Grid.RowSpan")),
        cell_index(a("Grid.ColumnSpan")),
    );
    if rs.is_some() || cs.is_some() {
        w = w.span(rs.unwrap_or(1), cs.unwrap_or(1));
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
            "padding" => match padding(v) {
                Some([t, r, b, l]) => w.padding(t, r, b, l),
                None => w,
            },
            "margin" => match padding(v) {
                Some([t, r, b, l]) => w.margin(t, r, b, l),
                None => w,
            },
            "halign" => match v.trim() {
                "left" => w.halign(HAlign::Left),
                "center" => w.halign(HAlign::Center),
                "right" => w.halign(HAlign::Right),
                "stretch" => w.halign(HAlign::Stretch),
                _ => w,
            },
            "valign" => match v.trim() {
                "top" => w.valign(VAlign::Top),
                "center" => w.valign(VAlign::Center),
                "bottom" => w.valign(VAlign::Bottom),
                "stretch" => w.valign(VAlign::Stretch),
                _ => w,
            },
            "bg" => match color(v) {
                Some(c) => w.bg(c),
                // `sprite:panel`, `mymod:gui/frame`: an image background.
                None if v.contains(':') => w.bg_image(v.trim()),
                None => w,
            },
            "color" => match color(v) {
                Some(c) => w.color(c),
                None => w,
            },
            "focus_color" => match color(v) {
                Some(c) => w.focus_color(c),
                None => w,
            },
            "shadow" => w.shadow(v.trim() == "true"),
            "enabled" => w.enabled(v.trim() != "false"),
            "font" if !v.trim().is_empty() => w.font(v.trim()),
            "placeholder" => w.placeholder(text(Some(v))),
            "max_length" => match v.trim().parse() {
                Ok(n) => w.max_length(n),
                Err(_) => w,
            },
            "on_change" => w.on_change(v),
            "on_submit" => w.on_submit(v),
            "no_wrap" if v.trim() == "true" => w.no_wrap(),
            "ellipsis" if v.trim() == "true" => w.ellipsis(),
            _ => w,
        };
    }
    if node.kind == "ScrollView"
        && let Some(offset) = scroll.get(&node.uid)
    {
        w = w.scroll_y(*offset);
    }
    if is_container(&node.kind) {
        let canvas = matches!(node.kind.as_str(), "Screen" | "Canvas");
        for child in widget_children(node) {
            w = w.child(widget(child, canvas, scroll));
        }
    }
    w
}

/// The anchored screen (`root_with`): a `screen_w × screen_h` panel with the
/// content placed per `anchor`.
pub fn screen(
    root: &YuiNode,
    screen_w: f32,
    screen_h: f32,
    scroll: &HashMap<String, f32>,
) -> Widget {
    let width = num(root.attr("width")).unwrap_or(176.0);
    let height = num(root.attr("height")).unwrap_or(166.0);
    let content = widget(root, false, scroll);
    let cx = ((screen_w - width) / 2.0).floor();
    let cy = ((screen_h - height) / 2.0).floor();
    let anchor = root.attr("anchor").unwrap_or("center").trim();
    let content = if anchor == "fill" {
        content
            .w(Units::Percent(100.0))
            .h(Units::Percent(100.0))
            .at(0.0, 0.0)
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
    widget::panel(FlexDir::Column)
        .w(Units::Px(screen_w))
        .h(Units::Px(screen_h))
        .child(content)
}
