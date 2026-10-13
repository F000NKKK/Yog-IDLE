# `.yui` screens

A `.yui` file is a mod's GUI screen in declarative form: a small XAML-like
XML document describing a [`yog-ui`](https://crates.io/crates/yog-ui) widget
tree. Yog-IDLE opens it the way Visual Studio opens XAML: the **Screen
Designer** (Toolbox, design canvas, Properties, Document Outline) and the
markup together in one tab, kept in step both ways — see [Designer](#designer).

`yog build`, `yog check` and `yog ui gen` turn every `src/**/foo.yui` into
`.yog-build/generated/**/foo.g.rs` — the counterpart of WPF's
`MainWindow.g.cs`: generated into the build directory on every build, never
committed, never edited by hand, pulled into a hand-written code-behind
module with `yog_api::ui_include!("foo")` (yog-cli 0.26+, yog-api 0.88+).
Yog-IDLE also regenerates it each time a `.yui` file is saved, so the
code-behind always sees the current screen. See [Generated code](#generated-code).

## Example

```xml
<?xml version="1.0" encoding="utf-8"?>
<Screen id="mymod:main_menu"
        width="176"
        height="166"
        anchor="center"
        bg="#C0101010"
        padding="8">
    <Label id="title"
           x="8"
           y="6"
           text="Main Menu"
           color="#FFFFFF"
           no_wrap="true" />
    <!-- Starts the game. -->
    <Button id="play"
            x="38"
            y="40"
            w="100"
            h="20"
            text="Play"
            bg="#FF555555"
            color="#FFFFFF"
            on_click="play" />
    <Row x="8"
         y="70"
         w="160"
         h="22"
         gap="2"
         align="center">
        <InvSlot item="minecraft:diamond" count="3" />
        <Spacer flex="1" />
        <ItemSlot item="minecraft:apple" />
    </Row>
</Screen>
```

That's the layout **Format Document** (Ctrl+K Ctrl+D or Shift+Alt+F)
writes, Visual Studio's XAML style: four-space indentation, attributes in a
fixed order (`id`, then position and size, then content, layout,
appearance, behavior), all on the start tag's line when there are at most
three and it fits in ~110 columns, otherwise one per line aligned under the
first; empty elements close with ` />`. Comments, the prolog and single
blank lines between elements are kept. Any layout parses — `yog build`
doesn't care.

## Elements

| Element | `yog-ui` widget | Notes |
|---|---|---|
| `Screen` | column panel | The root — exactly one. Its children are placed at `x`/`y`. |
| `Canvas` | column panel | Children placed freely at `x`/`y` (missing = 0). |
| `Column` | `panel(FlexDir::Column)` | Children flow top to bottom. |
| `Row` | `panel(FlexDir::Row)` | Children flow left to right. |
| `ScrollView` | `scroll_view()` | A Column that clips its children and scrolls them (`scroll_y`), with a scrollbar on overflow — yog-ui 0.35.2+. |
| `Label` | `label(text)` | |
| `Button` | `button(text)` | Text centered; no background unless `bg` is set. |
| `TextBox` | `text_box(text)` | One-line text input (vanilla `EditBox` look) — see [Text boxes](#text-boxes). yog-ui 0.36+. |
| `ItemSlot` | `item_slot(item)` | An item icon in an 18×18 slot. |
| `InvSlot` | `inv_slot(item, count)` | A vanilla-looking inventory slot. |
| `Image` | `mc_image(texture, tex_w, tex_h)` | A resource-pack texture. |
| `Spacer` | `spacer()` | Invisible; give it `flex` to push siblings apart. |

Inside a `Row`/`Column`, a child with `x` or `y` is taken out of the flow and
placed at that position (`Style::pos`, `.at(x, y)` — yog-ui 0.35.1+), like a
`Canvas` child.

### Sizing

How a Row/Column sizes its children (yog-ui 0.35.3+; the designer previews
the same rules):

- `w`/`h` in percent resolve once, against the container's content box —
  its size minus `padding` (and a ScrollView's 6px scrollbar strip) — on the
  same axis, in a Row and a Column alike, at any nesting depth: a `w="50%"`
  child of a `w="400" padding="0 10"` Row is 190 wide. While the
  container's own size along that axis is still `auto` and being measured
  (an auto-width Row inside a Row), the percent counts as `auto` until the
  container's final size is known. Positioned (`x`/`y`) children resolve
  percents against the content box too, capped to what is left past their
  offset.
- `flex` grows a child into the free space left after every other child
  (fixed, percent, content-sized and `dock="right"`/`"bottom"` ones) and the
  gaps; the grown size sticks, and the child's own children lay out against
  it (so `flex` children inside it grow too).
- A growing (`flex`) ScrollView with an auto height starts from its
  `min_h` rather than its content, so it fills exactly the free space and
  scrolls the rest — `<ScrollView flex="1">` under a header is a list that
  takes the remaining height.
- `auto` containers fit their content plus padding; `min_w`/`min_h` are a
  floor for content-sized widgets.

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
| `font` | font id | The text's font: `minecraft:default` (the default), `minecraft:uniform` (Unifont), `minecraft:alt` (enchanting table), `minecraft:illageralt`, or a resource pack's `namespace:name`. Drawn and measured by the game (yog-ui 0.36+). |
| `font_scale` | number | Text size multiplier. |
| `shadow` | `true`/`false` | Minecraft's drop shadow under the text — on by default, as for vanilla buttons and labels; `shadow="false"` for flat text. |
| `no_wrap`, `enabled` | `true`/`false` | Single-line text, takes clicks/focus. |
| `ellipsis` | `true`/`false` | Single-line text cut with `...` when too wide (yog-ui 0.35.2+). |
| `focus_style` | `outline` `fill` `none` | Focus indicator. |
| `on_click` | string | Event returned by `click()`; a constant in `events`. |

Kind-specific: `text` (Label, Button, TextBox), `placeholder`, `max_length`,
`on_change`, `on_submit` (TextBox), `item` (ItemSlot, InvSlot), `count`
(InvSlot), `texture`, `tex_w`, `tex_h` (Image). Unknown elements or
attributes are errors, reported with their line by `yog ui gen`/`yog build`.

The designer never rewrites the whole file: an edit there changes only the
attributes or elements it touched (a start tag that gains or loses
attributes is laid out again), so comments, attribute order and your own
formatting elsewhere stay as they were.

## Generated code

For `src/main_menu.yui`, `.yog-build/generated/main_menu.g.rs` (for
`src/screens/options.yui`: `.yog-build/generated/screens/options.g.rs`) is
written by every `yog build`, `yog check` and `yog ui gen` — and by
Yog-IDLE on each save of the `.yui`. It starts with a `// <auto-generated>`
header and is never committed (`.yog-build/` is git-ignored). The
code-behind pulls it in with

```rust
yog_api::ui_include!("main_menu");          // src/main_menu.yui
yog_api::ui_include!("screens/options");    // src/screens/options.yui
```

— `include!(concat!(env!("CARGO_MANIFEST_DIR"), "/generated/<name>.g.rs"))`:
`.yog-build/` is the mod's generated Cargo package, so the path needs no
configuration and resolves the same for `yog build`, `cargo clippy` in
`.yog-build/`, and rust-analyzer (VS Code's is pointed at
`.yog-build/Cargo.toml` by `yog build`), which completes and navigates into
the generated `ids`, `events` and functions.

In Yog-IDLE the generated file shows in Project Explorer nested under its
`.yui` (greyed, italic) and opens read-only, under a notice that it's
generated. Code Search (Ctrl+T) indexes its symbols; Find in Files searches
it when *Include generated files* is ticked.

**Upgrading from `.designer.rs`** (yog-cli 0.25 and older generated
`src/foo.designer.rs` next to the screen): `yog build` deletes a stale
`foo.designer.rs` next to a `.yui`, and stops with
`src/foo.rs:1: include!("foo.designer.rs") — ... replace it with
yog_api::ui_include!("foo");` for each code-behind still including one —
replace the line as it says. (A `lib.designer.rs` is something else: the
exports facade `yog build` writes for `[dependencies.exports]`.)

It defines:

- `ID`, `WIDTH`, `HEIGHT` — the UI id and design size;
- `mod events` / `mod ids` — `&str` constants for every `on_click`,
  `on_change`, `on_submit` and `id`;
- `build() -> Widget` — the tree;
- `root(screen_w, screen_h)` / `root_with(.., customize)` — a laid-out
  `UiRoot` for the window, the screen placed per its `anchor`; `customize`
  can change the tree first (text, enabled state, ...);
- `render(gfx)` / `render_with(gfx, customize)` — draw it (call from
  `on_ui_render`);
- `click(event) -> Option<String>` — the `on_click` of the widget under a
  `"click:X:Y"` UI event, hit-tested against the last render;
- `with_last(|ui| ...)` — the layout drawn by the last render, for event
  handlers that need rects or scroll state (`ui.find_node(ids::LIST)`);
- `text_box(id, &mut state, event) -> TextBoxEvent` — feeds a UI event to
  a text box (see [Text boxes](#text-boxes));
- `open()` — `open_ui(ID, modal, pause)`;
- `close()` — closes the screen if it's open, as Esc does (`close_ui(ID)`,
  yog-api 0.88+) — for a Done or Cancel button.

A code-behind module:

```rust
// src/main_menu.rs
yog_api::ui_include!("main_menu");

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

### Runtime content and scrolling

What only exists at runtime — one row per item, say — is added by the
code-behind, like WinForms code adding controls to a panel: give the
container an `id` in the markup and fill it in `render_with`'s `customize`
(`root.find_mut(ids::LIST)`, push `yog_api::ui::widget::...` children with
their own `on_click`s, e.g. `"select:3"`, which `click()` then returns).

A `ScrollView` scrolls by its widget's `style.scroll_y`; keep a
`yog_api::ui::ScrollState` per scroll view, set `scroll_y` from its
`offset` while rendering, and feed it the UI events first:

```rust
static LIST: Mutex<ScrollState> = Mutex::new(ScrollState::new());

registry.on_ui_render(ID, |gfx| render_with(gfx, |root| {
    let list = root.find_mut(ids::LIST).unwrap();
    list.style.scroll_y = LIST.lock().unwrap().offset;
    list.children = rows();
}));
registry.register_ui(ID, |_, event| {
    // wheel (`scroll:DY`), scrollbar click/drag/release
    let scrolled = with_last(|ui| {
        ui.find_node(ids::LIST)
            .is_some_and(|n| LIST.lock().unwrap().handle(event, n, 20.0))
    });
    if scrolled == Some(true) {
        return;
    }
    // ... click(event)
});
```

### Text boxes

A `TextBox`'s text, caret, selection and focus live in the code-behind, in
a `yog_api::ui::TextBoxState` per box (like `ScrollState`): `apply` it to
the widget while rendering, and give it the UI events first — `text_box()`
does the lookup against the last render:

```xml
<TextBox id="search" w="100%" h="16" placeholder="Search..." max_length="64" on_change="search" />
```

```rust
static SEARCH: Mutex<TextBoxState> = Mutex::new(TextBoxState::new());

registry.on_ui_render(ID, |gfx| render_with(gfx, |root| {
    SEARCH.lock().unwrap().apply(root.find_mut(ids::SEARCH).unwrap());
}));
// Returning `true` marks a key/char event as used, so the game skips its
// own handling of it (Esc closing the screen, E closing an inventory...).
registry.register_ui(ID, |_, event| {
    let mut search = SEARCH.lock().unwrap();
    match text_box(ids::SEARCH, &mut search, event) {
        TextBoxEvent::Changed => refilter(search.text()),
        TextBoxEvent::Submitted => { /* Enter */ }
        TextBoxEvent::Handled => {}
        TextBoxEvent::Ignored => return click(event).is_some(),
    }
    true
});
```

A click focuses the box (and places the caret; drag selects); while
focused it takes typing, Backspace/Delete, Left/Right/Home/End (Shift
selects, Ctrl moves by words), Ctrl+A/C/X/V, and Enter (`Submitted`). Esc
first unfocuses the box — the event is used, so the screen stays open — and
only a second Esc closes the screen. The text scrolls horizontally to keep
the caret in view; the border turns white (or `focus_color`) while focused,
and `placeholder` shows greyed while the text is empty. `max_length` caps
the characters (0 = no limit).

Keys and typed characters reach the handler as `key:KEY:MODS` (GLFW key
code and modifier bits) and `char:CODEPOINT` UI events (yog runtime 0.96+,
ABI 0.33).

Yog-Modlist's `src/mod_list.yui` + `src/mod_list.rs` is a complete example
(a search box filtering the list, and a Done button calling `close()`).

Call `main_menu::register(registry)` from the mod's `Mod::register`, and
`main_menu::open()` (or `registry.register_menu_entry("Main Menu", main_menu::ID)`)
to show it.

## Designer

The tab shows **Design and XAML** split, Visual Studio's XAML designer
layout; the buttons on the tab strip switch to the designer or the XAML
alone. In the split:

- **Design / ⇅ / XAML** on the boundary: the tabs focus a pane (or pick the
  one shown when collapsed), ⇅ swaps them; on the right, vertical or
  horizontal split and collapse/expand. Layout and splitter position are
  remembered.
- **Two-way sync** — what's typed in the XAML reaches the designer after a
  short pause; while the markup is invalid the last valid layout stays, with
  an *Invalid markup* bar (click it to go to the error). Designer edits are
  written into the XAML as patches, each its own undo step — Ctrl+Z in
  either pane undoes both kinds of edit.
- **Selection sync** — selecting a widget marks its tag in the XAML and
  moves the cursor there; moving the cursor into a tag selects that widget
  (Properties and Document Outline follow).
- **XAML editing** — highlighting, auto-closed tags, and completion of
  element names, the attributes each element has, and enum/boolean values
  (descriptions as in Properties).

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
`{"cmd":"hot_reload",...}` — the regenerated `.g.rs` comes along with the
mod.
