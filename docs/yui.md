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
| `Grid` | `grid()` | Rows and columns, children in cells — WPF's `Grid`; see [Grid](#grid). yog-ui 0.39+, yog-cli 0.29+. |
| `Canvas` | column panel | Children placed freely at `x`/`y` (missing = 0). |
| `Column` | `panel(FlexDir::Column)` | Children flow top to bottom. |
| `Row` | `panel(FlexDir::Row)` | Children flow left to right. |
| `ScrollView` | `scroll_view()` | A Column that clips its children and scrolls them (`scroll_y`), with a scrollbar on overflow — yog-ui 0.35.2+. |
| `Label` | `label(text)` | |
| `Button` | `button(text)` | Text centered; no background unless `bg` is set. |
| `TextBox` | `text_box(text)` | One-line text input (vanilla `EditBox` look) — see [Text boxes](#text-boxes). yog-ui 0.36+. |
| `ItemSlot` | `item_slot(item)` | An item icon in an 18×18 slot. |
| `InvSlot` | `inv_slot(item, count)` | A vanilla-looking inventory slot. |
| `Image` | `image(source)` | An item/block icon, a GUI sprite or a texture — see [Images](#images). yog-ui 0.37+. |
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
- `margin` is space outside a child (yog-ui 0.39+): it's kept clear in the
  flow, around docked and positioned children and inside grid cells.
- `halign` in a Column / `valign` in a Row places that one child across the
  container, overriding the container's `align`: `left`/`top`,
  `center`, `right`/`bottom`, or `stretch` (fill the width/height when the
  size is `auto`). An aligned child is measured at its content width — a
  Label takes the width its text needs instead of wrapping at the
  Column's. `halign` in a Row and `valign` in a Column do nothing (that's
  the flow direction; use `flex`/`dock`).

### Grid

`<Grid>` is WPF's/WinUI's `Grid`: rows and columns, each child in a cell —
the way to build a screen with a header, a list and a details pane without
nesting stack panels and `flex` spacers.

```xml
<Screen id="mymod:browser" width="320" height="200" padding="6">
    <Grid w="100%" h="100%" rows="Auto,*,22" columns="140,*" row_spacing="4" column_spacing="6">
        <Label Grid.ColumnSpan="2" text="@Strings.title" color="#FFFFFF" />
        <ScrollView Grid.Row="1" bg="#40000000" />
        <Column Grid.Row="1" Grid.Column="1" padding="4">
            <Label id="name" text="Name" />
        </Column>
        <Row Grid.Row="2" Grid.ColumnSpan="2" gap="4">
            <Spacer flex="1" />
            <Button text="Done" w="60" h="20" on_click="done" />
        </Row>
    </Grid>
</Screen>
```

**Rows and columns.** `rows` and `columns` list the sizes, comma-separated:

| Size | Meaning |
|---|---|
| `Auto` | Fits its content: the largest child in it. |
| `*`, `2*`, `0.5*` | A share of what the other rows/columns leave: `2*` gets twice what `*` gets. |
| `26` | A fixed size in GUI pixels. |

No `rows` = one `*` row, no `columns` = one `*` column (so a bare `<Grid>`
stacks its children on top of each other, filling it). With limits, use
WPF's property-element form instead — same sizes, `*` when `height`/`width`
is left out:

```xml
<Grid>
    <Grid.RowDefinitions>
        <RowDefinition height="Auto" />
        <RowDefinition min_height="40" />
    </Grid.RowDefinitions>
    <Grid.ColumnDefinitions>
        <ColumnDefinition width="2*" min_width="80" />
        <ColumnDefinition max_width="200" />
    </Grid.ColumnDefinitions>
    ...
</Grid>
```

An axis is defined one way or the other: `rows="..."` together with
`<Grid.RowDefinitions>` is an error. `row_spacing` and `column_spacing`
(WinUI's `RowSpacing`/`ColumnSpacing`, default 0) put space between rows and
between columns.

**Cells.** A child says where it goes with the attached properties
`Grid.Row`, `Grid.Column` (from 0, default 0), `Grid.RowSpan` and
`Grid.ColumnSpan` (default 1). Several children may share a cell (they're
drawn in order). `yog build` rejects a cell or span past the grid's last
row/column, a span of 0, `Grid.*` on a child of anything but a Grid, and
bound (`{x:Bind ...}`) definitions or cells — a grid's shape is fixed when
it's built. (The `Cell` of a widget built in code is clamped to the grid
instead, like WPF.)

**In its cell** a child gets the cell's rect less its `margin`, then:

- `halign`/`valign` `stretch` — the default in a cell — fill it; a child
  with an explicit `w`/`h` keeps it and is centred (WPF does the same).
- `left`/`center`/`right`, `top`/`center`/`bottom` — its own size (measured
  at its content width, capped to the cell), placed there.
- `x`/`y` take a child out of the cells: it's placed in the grid's content
  box, as in a Canvas.

**How the sizes are worked out** (WPF's algorithm; the designer previews
the same rules): columns first, then rows, each axis on its own —

1. pixel rows/columns take their size (within `min`/`max`; min wins);
2. `Auto` ones grow to the largest child that sits only in them —
   children spanning several grow the `Auto` ones among them only by what's
   still missing, shared equally; a child spanning a `*` row/column
   doesn't size `Auto` ones;
3. `*` ones share what's left in proportion to their weights; one whose
   share breaks its `min`/`max` takes that limit and the rest share again.

Rows are measured at their final column widths, so wrapped text gets its
real height. A grid with `auto` width/height (no `w`/`h`, or inside a
ScrollView) has no space to share along that axis: its `*` rows/columns
act as `Auto` and the grid is the sum of its rows/columns plus spacing and
padding — a `Grid` in a ScrollView is as tall as its content and scrolls.
A `*` row never grows from its content when the grid has a height: a long
list in a `*` row scrolls (as a ScrollView there) instead of pushing the
rows after it off the screen.

**Why some names are lowercase.** Plain attributes in `.yui` are snake_case
and lowercase everywhere (`min_w`, `font_scale`, `on_click`), and Grid
follows suit: `rows`, `columns`, `row_spacing`, `height`, `min_width`,
`halign`, `margin`. What is XAML *structure* rather than a property keeps
XAML's spelling, so markup copied from WPF reads the same: property
elements (`<Grid.RowDefinitions>`), the definition elements
(`<RowDefinition>`) and the attached properties (`Grid.Row`,
`Grid.ColumnSpan`), which name another element's property. WPF spellings of
plain attributes are errors with a hint — `Height` → `height`,
`HorizontalAlignment` → `halign`.

From code, the same grid is `widget::grid().rows([Track::auto(),
Track::star(1.0), Track::px(22.0)]).cols(...).row_spacing(4.0)` with
children `.cell(row, col)` / `.span(rows, cols)`, `.halign(HAlign::Left)`,
`.margin(t, r, b, l)` (`yog_api::ui`).

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
| `margin` | `4`, `4 8`, `1 2 3 4` | Outer spacing, the same order — in a Row/Column and a grid cell (yog-ui 0.39+). |
| `halign` | `left` `center` `right` `stretch` | Horizontal placement in a grid cell (default `stretch`), or in a Column (overrides its `align`). |
| `valign` | `top` `center` `bottom` `stretch` | Vertical placement in a grid cell (default `stretch`), or in a Row. |
| `Grid.Row`, `Grid.Column`, `Grid.RowSpan`, `Grid.ColumnSpan` | number | A Grid child's cell — see [Grid](#grid). |
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
`on_change`, `on_submit` (TextBox), `rows`, `columns`, `row_spacing`,
`column_spacing` (Grid), `item` (ItemSlot, InvSlot), `count`
(InvSlot), `source`, `stretch`, `uv`, `tint` (Image; see [Images](#images)). Unknown elements or
attributes are errors, reported with their line by `yog ui gen`/`yog build`.

**Resources and translations.** A `text` or `placeholder` starting with
`@` is looked up when the tree is built, in the player's language:
`text="@Strings.screen.title"` is a text of `resources/Strings.yres`, any
other `@some.key` a translation key as is, and `@@` starts a literal `@`
(`text="@@home"` shows `@home`). An Image's `source="@Icons.logo"` is an
image of `resources/Icons.yres`. See [`.yres` resource files](yres.md); the
designer shows the texts in the IDE's language.

The designer never rewrites the whole file: an edit there changes only the
attributes or elements it touched (a start tag that gains or loses
attributes is laid out again), so comments, attribute order and your own
formatting elsewhere stay as they were.

## Images

`<Image source="…">` shows a picture named by a **Yog image source** — never a
raw Minecraft resource path. The host resolves the source for the Minecraft
version and loader it runs on (`draw2d_image`, yog-abi 0.27 / ABI minor 34),
so the same mod binary draws the same picture on 1.20.1 and 1.21.x, Fabric,
NeoForge and Forge.

| Source | Shows |
|---|---|
| `item:<id>` | An item's icon through the game's item renderer (3D block items, modded items): `item:apple`, `item:mymod:wand`. |
| `block:<id>` | A block's item form: `block:crafting_table`. |
| `sprite:<name>` | A vanilla GUI sprite by Yog's stable name (table below): `sprite:button`, `sprite:icon/heart`. |
| `mod:<path>` | This mod's own image, `assets/<mod id>/textures/<path>.png`: `mod:gui/logo`. `yog build` fills in the mod id. |
| `<ns>:<path>` | `assets/<ns>/textures/<path>.png` — another mod's image (or yours, spelled out): `othermod:gui/logo`. |
| `<ns>:textures/<path>.png` | Not accepted — a raw resource path depends on the Minecraft version; `yog build` fails naming the alias to write instead (`minecraft:textures/item/apple.png` → `item:apple`, `mymod:textures/gui/logo.png` → `mymod:gui/logo`). |

Ids without a namespace are `minecraft:`. Unknown sprite names are build
errors; an image that can't be found in game is logged once and skipped.

| Attribute | Value | Meaning |
|---|---|---|
| `source` | image source | What to show (required). |
| `stretch` | `None` `Fill` `Uniform` `UniformToFill` | How the image fills the widget, as in WPF — `None`: natural size, centered (cut when larger); `Fill`: the whole box, aspect not kept; `Uniform` (default): as large as fits, aspect kept, centered; `UniformToFill`: covers the box, aspect kept, overflow cut (textures only — items and sprites fall back to `Uniform`). Case-insensitive. |
| `w`, `h` | size | The widget's box. Without them the widget takes the image's natural size (16×16 for items, a sprite's size, a texture's pixel size). |
| `uv` | `u v w h` | Part of a texture to show, in the image's pixels (sprite sheets). Textures only. |
| `tint` | color | Multiplies the image's colors (`#AARRGGBB`; items aren't tinted). |

Images are drawn nearest-neighbour (pixel-art stays crisp), clipped by
scroll views like everything else.

In Rust: `widget::image(source).stretch(Stretch::Fill).region([u, v, w,
h]).tint(c)`, or `Draw2D::image(source, x, y, w, h)` /
`Draw2D::image_region` outside yog-ui.

### Sprites

GUI sprites have stable Yog names. On 1.20.2+ they map to the GUI sprite
atlas (`assets/minecraft/textures/gui/sprites/<atlas id>.png`); on 1.20.1 to
regions of `textures/gui/widgets.png`, `icons.png`, … (nine-sliced when
stretched, like the atlas' own scaling). The list lives in
`yog_gfx::image::SPRITES`; `sprite:<ns>:<atlas id>` names any atlas sprite
directly (1.20.2+ only).

| Source | What | Size | 1.20.2+ atlas id |
|---|---|---|---|
| `sprite:button` | Button background | 200×20 | `widget/button` |
| `sprite:button_hover` | Button background, hovered/focused | 200×20 | `widget/button_highlighted` |
| `sprite:button_disabled` | Button background, disabled | 200×20 | `widget/button_disabled` |
| `sprite:scrollbar` | Scrollbar knob (creative inventory) | 12×15 | `container/creative_inventory/scroller` |
| `sprite:scrollbar_disabled` | Scrollbar knob, disabled | 12×15 | `container/creative_inventory/scroller_disabled` |
| `sprite:checkbox` | Checkbox, unchecked | 20×20 | `widget/checkbox` |
| `sprite:checkbox_checked` | Checkbox, checked | 20×20 | `widget/checkbox_selected` |
| `sprite:hotbar` | Hotbar | 182×22 | `hud/hotbar` |
| `sprite:hotbar_selection` | Hotbar selection frame | 24×23 | `hud/hotbar_selection` |
| `sprite:crosshair` | Crosshair | 15×15 | `hud/crosshair` |
| `sprite:xp_bar` | Experience bar, empty | 182×5 | `hud/experience_bar_background` |
| `sprite:xp_bar_progress` | Experience bar, full | 182×5 | `hud/experience_bar_progress` |
| `sprite:icon/heart` | Heart | 9×9 | `hud/heart/full` |
| `sprite:icon/heart_half` | Half heart | 9×9 | `hud/heart/half` |
| `sprite:icon/heart_empty` | Heart container (empty) | 9×9 | `hud/heart/container` |
| `sprite:icon/food` | Hunger shank | 9×9 | `hud/food_full` |
| `sprite:icon/food_half` | Half hunger shank | 9×9 | `hud/food_half` |
| `sprite:icon/food_empty` | Hunger shank, empty | 9×9 | `hud/food_empty` |
| `sprite:icon/armor` | Armor | 9×9 | `hud/armor_full` |
| `sprite:icon/armor_half` | Half armor | 9×9 | `hud/armor_half` |
| `sprite:icon/armor_empty` | Armor, empty | 9×9 | `hud/armor_empty` |
| `sprite:icon/air` | Air bubble | 9×9 | `hud/air` |
| `sprite:icon/air_bursting` | Air bubble, bursting | 9×9 | `hud/air_bursting` |
| `sprite:slot` | Inventory slot (18×18) | 18×18 | drawn by Yog |

In the designer, the **Source** property offers this mod's textures, the
sprite list and the game's items and blocks, with a preview; a raw path gets
a hint with the alias to use.

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

A screen with `x:ViewModel` doesn't need any of this: see the next section.

Call `main_menu::register(registry)` from the mod's `Mod::register`, and
`main_menu::open()` (or `registry.register_menu_entry("Main Menu", main_menu::ID)`)
to show it.

## View-model screens

`<Screen ... x:ViewModel="MyVm">` switches the screen to
[yog-kit](mvvm.md): `{x:Bind ...}` bindings, `command="{x:Bind method()}"`,
two-way text boxes and toggles, `ListView`/`ItemsControl`/`ContentPresenter`
with item templates, `<Screen.Resources>` styles and `hover:`/`checked:`/...
state attributes. The code-behind is just the view-model struct; text boxes,
scrolling, focus and keyboard navigation need no code. Instead of the
functions above, the generated file has `register(registry)` (returning a
`ScreenHandle`), `open()`, `close()`, `ID` and `ids`. `on_click`,
`on_change` and `on_submit` are errors there. Full reference:
[mvvm.md](mvvm.md); Yog-Modlist's `src/mod_list.yui` + `src/mod_list.rs`
is a complete example.

## Components

A mod's own reusable widgets — WPF's user controls — are `.yui` files too,
with a `<Component>` root instead of `<Screen>`: their properties and events
declared in markup, then **one** body element bound to them with
`{x:Bind ...}` (the [view-model](mvvm.md) binding syntax). Add one with
**Add > New Item > Component (.yui)**. Yog-Modlist's `src/pill.yui` and
`src/stat_bar.yui` (+ `stat_bar.rs`) are complete examples.

```xml
<Component name="StatBar" description="@Strings.component.stat_bar" icon="item:experience_bottle"
           design_w="120" design_h="16">
    <Property name="label" type="text" default="Progress" doc="Caption above the bar"/>
    <Property name="value" type="number" default="0.5" doc="Filled fraction, 0..1"/>
    <Property name="fill" type="color" default="#FF55C055" category="Appearance"/>
    <Event name="on_select" doc="Raised when the bar is clicked"/>
    <Column min_w="60" gap="2" on_click="{x:Bind on_select}">
        <Label text="{x:Bind caption()}" d:text="Loaded 50%" no_wrap="true"/>
        <Row w="100%" h="5" bg="#FF303030">
            <Spacer w="{x:Bind filled()}" h="100%" bg="{x:Bind fill}"/>
        </Row>
    </Column>
</Component>
```

Used from any screen (or another component) like a built-in element:
`<StatBar x="8" y="30" w="120" label="Loaded" value="0.75"/>`. Attributes
every element has (`x`, `y`, `w`, `h`, `bg`, `padding`, `on_click`, ...)
set on an instance apply to the body's root; the declared ones are the
component's properties.

**`<Component>`** — the type and its designer metadata (the WPF
`[ToolboxItem]`, `[Description]`, `[Category]` attributes). Texts may be
`@Set.key` resource references (translated, see [yres.md](yres.md)).

| Attribute | |
|---|---|
| `name` | The element / Rust type name, PascalCase (default: the file's stem, `stat_bar` → `StatBar`). |
| `display_name` | The Toolbox's label (default: `name`). |
| `description` | The Toolbox tooltip and the Properties description of instances. |
| `icon` | The Toolbox icon: a Yog image source (`item:…`, `block:…`, `sprite:…`, `mod:…`) or `@Icons.x`. Default: a generic glyph. |
| `category` | The Toolbox category (default: *&lt;mod&gt; Components*). |
| `toolbox` | `false` hides it from the Toolbox (parts used only inside other components). |
| `design_w`, `design_h` | The designer canvas size for editing it (default 120×40), and an instance's `w`/`h` when dropped from the Toolbox (none when unset). |
| `d:bg` | A background drawn only in the designer. |

**`<Property name type default doc category options>`** — `name` is
snake_case and can't be an attribute every element has. `type`: `text`
(default), `number` (f32), `int` (i64), `bool`, `color` (`#RRGGBB` /
`#AARRGGBB`, u32), `choice` (one of `options="a, b, c"`, String), `image`
(an image source). `default` is used when an instance doesn't set it (and
in the designer); `doc` and `category` (default: the component's name) are
what Properties shows for instances. **`<Event name doc category>`** — an
event the component raises: instances name it (`on_select="pick_mod"`), the
body passes it on (`on_click="{x:Bind on_select}"`).

**Bindings** — `{x:Bind prop}` reads a property; anything else
(`{x:Bind caption()}`, `{x:Bind value * 100.0}`) is Rust evaluated on the
generated struct, `self` being the component — methods go in the optional
code-behind. Bindings are evaluated once per instance, when the screen's
tree is built (`Mode=OneTime`). Bindable: `text`, `placeholder`, `source`,
`item`, `count`, `bg`, `color`, `focus_color`, `tint`, `enabled`,
`visible`, `shadow`, `w`, `h` (a number = px, `Units`, `"50%"`, `"auto"`),
`gap`, `flex`, `min_w`, `min_h`, `font_scale`, `on_click`/`on_change`/
`on_submit`, and a nested component's properties. `d:<attr>` values are
design-time only: the designer shows them instead (sample text for a
binding it can't evaluate); the generated code ignores them.

**Generated code** — `yog build` / `yog check` / `yog ui gen` (yog-cli
0.28.2+, yog-ui 0.38.2+, yog-api 0.90.2+) generate
`.yog-build/generated/<path>.g.rs`: `pub struct StatBar` with one typed
`pub` field per property, `from_props`, `view()`, the
`yog_api::ui::component::Component` implementation (its `NAME`, `DOC`,
`DISPLAY_NAME`, `ICON`, `CATEGORY`, `DESIGN_SIZE`, `TOOLBOX` constants and
`PROPS` carry the metadata above, for the designer host) and its
registration. A component with a code-behind `<name>.rs` pulls it in there:

```rust
yog_api::ui_include!("stat_bar");

impl StatBar {
    fn caption(&self) -> String { format!("{} {}%", self.label, (self.value * 100.0).round()) }
    fn filled(&self) -> yog_api::Units { yog_api::Units::Percent(self.value.clamp(0.0, 1.0) * 100.0) }
}
```

(`mod stat_bar;` in `lib.rs`). Components without one are compiled in by a
single `yog_api::ui_components!();` in `src/lib.rs` (from
`.yog-build/generated/components.g.rs`; `yog build` warns when it's
missing).

**In the designer**

- The **Toolbox** always lists the open mod's components — under
  *&lt;mod&gt; Components* or their own `category` — with their icon,
  display name and description as the tooltip, even before a `.yui` is open
  (greyed then); it follows component files being added, renamed and
  removed. A component isn't offered inside its own `.yui`.
- **Instances are drawn for real.** A component whose bindings only read
  its properties is drawn by expanding its markup, no build needed — edit
  its `.yui` and every instance follows. One whose bindings call code is
  drawn by the mod itself: the IDE builds it for the host machine (`yog
  designer-lib`, debounced after edits; *Building designer library…* in the
  Toolbox meanwhile) and loads it into a separate host process, so a panic
  or crash in mod code never takes the IDE down. That needs the IDE's
  yog-ui ABI to match the mod's. Unknown components, a failed build or a
  component that panics show a red placeholder box with the reason.
- **Properties** of an instance: the component's properties in their
  categories (colors with swatches, `choice` as a list, `bool` as a
  checkbox), its events under Events, then the common layout/appearance
  attributes; the component's description is the header's tooltip and the
  description pane's text.
- **Editing a component's own `.yui`** works like a screen: the canvas is
  `design_w`×`design_h`, the body is drawn with the properties' defaults
  (`d:` values win; code bindings show as `{expr}` in texts), new widgets
  go into the body, and selecting the root, a `<Property>` or an `<Event>`
  (Document Outline / XAML) edits the metadata and declarations in
  Properties. Project Explorer nests `stat_bar.rs` and the generated
  `stat_bar.g.rs` under `stat_bar.yui`, as for screens.

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
  (the game window divided by its GUI scale) and zoom.
- **Drawn as in game** — the picture comes from `yog-ui` itself (the crate
  mods render with): the `.yui` is built into the same widget tree the
  generated `.g.rs` builds, laid out and rendered by yog-ui into a
  recording `YogGfxApi`, and rasterized with Minecraft's own font (bitmap,
  Unifont, `font=` ids such as `minecraft:alt`, `§` codes, drop shadow) and
  textures/items — read at run time from the local client jar
  (`~/.minecraft/versions`, the loaders' Gradle caches) and the asset index,
  never copied into the project. A mod's own `assets/` (textures, fonts) win
  over vanilla's. The selection handles, snaplines and dashed outlines of
  containers/spacers are drawn on top, at yog-ui's own rects. Without a
  client jar a bar says so and an approximation (`layout.ts`, a port of
  yog-ui's layout, with a CSS stand-in font) is shown.
- **Preview** (toolbar) — the screen takes the mouse and keyboard as in game:
  hover and press buttons, scroll ScrollViews (wheel, scrollbar) through
  yog-ui's `ScrollState`, type into TextBoxes (`max_length` honored, Enter
  submits). Events aren't run — they're shown in the toolbar and in Output
  (General), e.g. `click: filter_all`, `change: search "abc"`. Leaving the
  preview resets it; designing is the default.
- **Event handlers** — as in Visual Studio, double-click a Button (or a
  TextBox, or anything with `on_click`) to go to its handler: the event is
  named first if it has none (`on_click="<id>_click"`), then the screen's
  code-behind `<name>.rs` gets the arm `events::<NAME> => <name>(),` in its
  `match` and an empty `fn <name>()` — or a new code-behind file with
  `ui_include!`, `on_event` and `register` — and opens with the caret in the
  handler. An existing handler is just opened. In Properties the **Events**
  category (On Click / On Change / On Submit) offers a fresh name; entering
  a name does the same.
- **Select** — click; Ctrl/Shift+click adds; drag on empty space for a
  rubber band; Esc selects the parent; Ctrl+A selects the screen's
  children.
- **Move / resize** — drag; handles on the primary selection; snaplines to
  siblings and the container, 2px grid (Snap toggle; hold Alt to suspend).
  Dropping onto another container moves the widget into it; in a Row/Column
  the drop position picks its place in the flow, in a Grid its cell
  (`Grid.Row`/`Grid.Column` are set; `Grid.*` attributes are dropped when a
  widget leaves a grid).
- **Grid** — as in Visual Studio: dashed lines between every grid's rows
  and columns, and on the selected grid (or the grid of the selected
  widget) rails above and left of it with each column's/row's size (`Auto`,
  `2*`, `26`; the tooltip has the pixels). Click a rail to add a line
  there (the row/column under the pointer is split; children after it keep
  their cells); drag a line's grip on the rail to resize the two rows/columns
  beside it (`*` ones stay `*`, reweighted; others become pixels);
  right-click a size for Auto / * / pixels, inserting or deleting a
  row/column, or the collection editor. In Properties, a grid's **Rows** /
  **Columns** take the compact list (`Auto,*,26`) and their **…** opens the
  RowDefinition/ColumnDefinition editor (sizes, minimum and maximum, order);
  a grid child shows **Row**, **Column**, **Row Span** and **Column Span**.
  The designer keeps whichever form the file uses (`rows="..."` or
  `<Grid.RowDefinitions>`), switching to the element form when a limit
  needs it.
- **Keyboard** — arrows move 1px (Ctrl: 8px), Shift+arrows resize; in a
  Row/Column arrows move a widget earlier/later, in a Grid to the next
  cell. Delete, Ctrl+X/C/V,
  Ctrl+D (duplicate), Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z (undo/redo, also in the
  Edit menu) — from the canvas, the Toolbox, Document Outline or Properties
  alike; each gesture is one step, and undo brings back the selection that
  went with it.
- **Toolbox** — drag a widget onto the canvas, or double-click it to add it
  into the selected container. The mod's own components are listed too
  (see [Components](#components)).
- **Properties** — every attribute of the selection, grouped; with several
  widgets selected, only what they share.

Live preview in the running game is not wired yet. The natural route is the
runtime's control socket: on save, rebuild with `--local-api` and send
`{"cmd":"hot_reload",...}` — the regenerated `.g.rs` comes along with the
mod.
