# `.yui` screens

A `.yui` file is a mod's GUI screen in declarative form: a small XAML-like
XML document describing a [`yog-ui`](https://crates.io/crates/yog-ui) widget
tree. Yog-IDLE opens it in the **Screen Designer** (Toolbox, design canvas,
Properties, Document Outline — Visual Studio's WinForms designer), with the
XML itself one click away in the **Source** view.

`yog build` (and `yog ui gen`) turns every `src/**/foo.yui` into a sibling
`foo.designer.rs` — the counterpart of WinForms' `Form1.Designer.cs`:
generated, git-ignored, never edited by hand, `include!`d from a hand-written
code-behind module. Yog-IDLE also regenerates it each time a `.yui` file is
saved.

## Example

```xml
<?xml version="1.0" encoding="utf-8"?>
<Screen id="mymod:main_menu" width="176" height="166" anchor="center" bg="#C0101010" padding="8">
  <Label id="title" x="8" y="6" text="Main Menu" color="#FFFFFF" no_wrap="true"/>
  <Button id="play" x="38" y="40" w="100" h="20" text="Play" bg="#FF555555" color="#FFFFFF" on_click="play"/>
  <Row x="8" y="70" w="160" h="22" gap="2" align="center">
    <InvSlot item="minecraft:diamond" count="3"/>
    <Spacer flex="1"/>
    <ItemSlot item="minecraft:apple"/>
  </Row>
</Screen>
```

## Elements

| Element | `yog-ui` widget | Notes |
|---|---|---|
| `Screen` | column panel | The root — exactly one. Its children are placed at `x`/`y`. |
| `Canvas` | column panel | Children placed freely at `x`/`y` (missing = 0). |
| `Column` | `panel(FlexDir::Column)` | Children flow top to bottom. |
| `Row` | `panel(FlexDir::Row)` | Children flow left to right. |
| `Label` | `label(text)` | |
| `Button` | `button(text)` | Text centered; no background unless `bg` is set. |
| `ItemSlot` | `item_slot(item)` | An item icon in an 18×18 slot. |
| `InvSlot` | `inv_slot(item, count)` | A vanilla-looking inventory slot. |
| `Image` | `mc_image(texture, tex_w, tex_h)` | A resource-pack texture. |
| `Spacer` | `spacer()` | Invisible; give it `flex` to push siblings apart. |

Inside a `Row`/`Column`, a child with `x` or `y` is taken out of the flow and
placed at that position (`Style::pos`, `.at(x, y)` — yog-ui 0.35.1+), like a
`Canvas` child.

## Attributes

Named after the builder methods they become.

**`Screen` only**

| Attribute | Default | Meaning |
|---|---|---|
| `id` | — (required) | The UI id, `<modid>:<name>` — `register_ui`, `on_ui_render`, `open_ui`. |
| `width`, `height` | 176, 166 | Design size in GUI pixels. |
| `anchor` | `center` | `center`, `top_left`, `top`, `top_right`, `left`, `right`, `bottom_left`, `bottom`, `bottom_right`, or `fill` (the whole window). |
| `modal` | `true` | `open_ui`'s `modal`. |
| `pause` | `false` | `open_ui`'s `pause`. |

**Every element**

| Attribute | Value | Meaning |
|---|---|---|
| `id` | identifier | Widget id (`Widget::find_mut`); a constant in `ids`. |
| `x`, `y` | number | Position in the container's content box (inside its padding). |
| `w`, `h` | `80`, `50%`, `auto` | Size: pixels, percent of the container, or content-sized. |
| `min_w`, `min_h` | number | Minimum size (default 4). |
| `flex` | number | Share of a Row's/Column's free space. |
| `dock` | `none` `fill` `left` `right` `top` `bottom` | Docking in a Row/Column. |
| `gap` | number | Space between flowing children (default 2). |
| `padding` | `4`, `4 8`, `1 2 3 4` | Inner spacing, CSS order (top right bottom left). |
| `align` | `start` `center` `end` | Children's cross-axis alignment; a Label's text alignment. |
| `bg`, `color`, `focus_color` | `#RRGGBB`, `#AARRGGBB`, `0xAARRGGBB` | Background, text and focus colors. |
| `font_scale` | number | Text size multiplier. |
| `shadow`, `no_wrap`, `enabled` | `true`/`false` | Text shadow, single-line text, takes clicks/focus. |
| `focus_style` | `outline` `fill` `none` | Focus indicator. |
| `on_click` | string | Event returned by `click()`; a constant in `events`. |

Kind-specific: `text` (Label, Button), `item` (ItemSlot, InvSlot), `count`
(InvSlot), `texture`, `tex_w`, `tex_h` (Image). Unknown elements or
attributes are errors, reported with their line by `yog ui gen`/`yog build`.

Comments before the root element are kept by the designer; comments inside
the tree are dropped when the designer rewrites the file.

## Generated code

For `src/main_menu.yui`, `src/main_menu.designer.rs` defines:

- `ID`, `WIDTH`, `HEIGHT` — the UI id and design size;
- `mod events` / `mod ids` — `&str` constants for every `on_click` and `id`;
- `build() -> Widget` — the tree;
- `root(screen_w, screen_h)` / `root_with(.., customize)` — a laid-out
  `UiRoot` for the window, the screen placed per its `anchor`; `customize`
  can change the tree first (text, enabled state, ...);
- `render(gfx)` / `render_with(gfx, customize)` — draw it (call from
  `on_ui_render`);
- `click(event) -> Option<String>` — the `on_click` of the widget under a
  `"click:X:Y"` UI event, hit-tested against the last render;
- `open()` — `open_ui(ID, modal, pause)`.

A code-behind module:

```rust
// src/main_menu.rs
include!("main_menu.designer.rs");

pub fn register(registry: &mut yog_api::Registry) {
    registry.on_ui_render(ID, |gfx| {
        render_with(gfx, |root| {
            if let Some(title) = root.find_mut(ids::TITLE) {
                title.set_text("Hello!");
            }
        });
    });
    registry.register_ui(ID, |_ui_id, event| {
        if click(event).as_deref() == Some(events::PLAY) {
            // ...
        }
    });
}
```

Call `main_menu::register(registry)` from the mod's `Mod::register`, and
`main_menu::open()` (or `registry.register_menu_entry("Main Menu", main_menu::ID)`)
to show it.

## Designer

- **GUI size / Zoom** — the screen is drawn at a chosen GUI resolution
  (the game window divided by its GUI scale) and zoom; layout is a port of
  `yog-ui`'s own, so positions match the game.
- **Select** — click; Ctrl/Shift+click adds; drag on empty space for a
  rubber band; Esc selects the parent; Ctrl+A selects the screen's
  children.
- **Move / resize** — drag; handles on the primary selection; snaplines to
  siblings and the container, 2px grid (Snap toggle; hold Alt to suspend).
  Dropping onto another container moves the widget into it; in a Row/Column
  the drop position picks its place in the flow.
- **Keyboard** — arrows move 1px (Ctrl: 8px), Shift+arrows resize; in a
  Row/Column arrows move a widget earlier/later. Delete, Ctrl+X/C/V,
  Ctrl+D (duplicate), Ctrl+Z / Ctrl+Y (undo/redo, also in the Edit menu).
- **Toolbox** — drag a widget onto the canvas, or double-click it to add it
  into the selected container.
- **Properties** — every attribute of the selection, grouped; with several
  widgets selected, only what they share.

Live preview in the running game is not wired yet. The natural route is the
runtime's control socket: on save, rebuild with `--local-api` and send
`{"cmd":"hot_reload",...}` — the regenerated `*.designer.rs` comes along
with the mod.
