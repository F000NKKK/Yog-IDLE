# Blocks and items (`.yblock` / `.yitem`)

A mod's blocks and items live in `content/` — one JSON file each, holding
everything about it: name, properties, 3D model, block states and item form.
`yog build` compiles them into the Minecraft assets and data, and generates
Rust code that registers them. Yog-IDLE opens them in a 3D model editor.

```
my-mod/
  content/
    ores/ruby_ore.yblock
    ruby.yitem
  resources/
    Textures.yres        # "ruby": { "type": "image", "value": "item/ruby.png" }
    item/ruby.png
```

## The format

JSON (`//` comments and trailing commas are accepted). Unknown keys are
errors, so typos don't silently do nothing. `yog content check` checks every
file without building.

### Common keys

| Key | Meaning |
|---|---|
| `format` | Optional, `1`. |
| `id` | `namespace:name` or `name` (the mod's namespace). Default: the file stem. |
| `name` | Display name: a literal English text (goes to `en_us`), or `@Set.name` — a text of a `.yres` file, translated like any other (its culture variants supply the other languages). |
| `tooltip` | A line under the name — literal or `@Set.name`. |
| `register` | `"auto"` (default): registered by `yog_api::content!()`. `"manual"`: you register it yourself (see [Rust](#rust)). |
| `model` | The model (see [Models](#models)). Required. |

### `.yblock`

```jsonc
{
  "name": "@Strings.ruby_ore",
  "block": {
    "hardness": 3, "resistance": 3, "sound": "stone",
    "tool": "pickaxe", "tool_level": "iron", "requires_tool": true,
    "drops": { "item": "mymod:ruby", "count": [1, 3] }
  },
  "model": { "parent": "cube_all", "textures": { "all": "@Textures.ruby_ore" } },
  "states": { "rotations": [{ "y": 0 }, { "y": 90 }, { "y": 180 }, { "y": 270 }] }
}
```

`block`:

| Key | Values |
|---|---|
| `hardness`, `resistance` | Numbers (stone: 1.5, 6; `hardness: -1` = unbreakable). |
| `sound` | `stone wood grass gravel sand snow metal glass wool nether_brick` |
| `light` | 0–15. |
| `tool` | `pickaxe axe shovel hoe` — the `minecraft:mineable/<tool>` tag. |
| `tool_level` | `stone iron diamond` — the `needs_<level>_tool` tag. |
| `requires_tool` | Drops nothing unless mined with the right tool. |
| `collision` | `false` — entities walk through it. |
| `slipperiness` | 0–1 (ice: 0.98). |
| `shape` | `"auto"` (default: the model's elements' bounding box), `"full"`, or `[x1, y1, z1, x2, y2, z2]` in pixels. |
| `render_layer` | `solid cutout cutout_mipped translucent` — `cutout` for textures with transparent pixels. |
| `drops` | `"self"` (default), `"none"`, or `{ "item": "ns:id", "count": n \| [min, max] }`. |
| `connect_groups` | Group names this block connects to (with `states.connect`). Default: its own id. |

`item_model` — optional: the item's own model (a sprite, typically) instead
of the block model in hand and in inventories.

`states`:

- `rotations` — random variants per position, as vanilla does for stone:
  `[{ "x": 0, "y": 90, "weight": 1, "uvlock": false }, …]`, angles 0/90/180/270.
- `connect` — `{ "arm": <model>, "uvlock": false }`: a block that connects
  to its neighbors (pipes, fences). `arm` is the model of the part pointing
  north; it's rotated towards each connected side. The block gets six boolean
  states (`north`…`down`) from the loader.

### `.yitem`

```jsonc
{
  "name": "@Strings.ruby",
  "tooltip": "Shiny.",
  "item": { "stack_size": 16, "food": { "nutrition": 4, "saturation": 0.3 } },
  "model": { "parent": "generated", "textures": { "layer0": "@Textures.ruby" } }
}
```

`item`: `stack_size` (1–99), `durability`, `fire_resistant`, `fuel_ticks`,
`food` `{ nutrition, saturation, always_edible }`.

### Models

Minecraft's block model JSON, with a few conveniences:

- `parent` — a template, or any model id (`minecraft:block/lantern`).
  Templates: `cube_all` (slot `all`), `cube_column` (`end`, `side`),
  `cube_bottom_top` (`top`, `bottom`, `side`), `cube` (one per face),
  `orientable` (`front`, `side`, `top`), `cross` (`cross`); for items
  `generated` and `handheld` (`layer0`, `layer1`, …). No parent and
  `elements` = a model of your own.
- `textures` — slot → texture, where a texture is
  - `@Set.name` — an image of a `.yres` file;
  - `path/in/resources.png` — a png under `resources/` (bundled; a
    `.png.mcmeta` next to it is bundled too, for animations);
  - a texture id — `minecraft:block/stone`, `mymod:block/x` (from `assets/`);
  - `#slot` — another slot.

  `particle` defaults to the first texture.
- `elements` — as Minecraft: `from`/`to` in pixels (-16…32), `rotation`
  (one axis, angle -45/-22.5/0/22.5/45, `origin`, `rescale`), `shade`, and
  `faces` with `texture` (`#slot`), `uv` (default: from the element's
  position), `rotation` (0/90/180/270), `cullface`, `tint`. A `name` per
  element is kept for the editor (Minecraft ignores it).
- `display`, `ambient_occlusion`, `gui_light` — as Minecraft.

## What `yog build` generates

For each block: `models/block/<name>.json` (+ `_arm`), `blockstates/<name>.json`,
the item model and the 1.21.4+ item definition (`items/<name>.json`), a loot
table, the mining tags; for each item its model and definition; names and
tooltips into the lang files (`block.<ns>.<name>` / `item.<ns>.<name>`,
tooltip under `.desc`); and `.yog-build/generated/yog-content.g.rs`.

Blocks and items no longer come from anything else: a texture in `assets/`
alone doesn't make a block or item model.

## Rust

```rust
yog_api::content!();          // in lib.rs, before export_mod!

// Everything with "register": "auto" is registered after Mod::register.
// The generated code also gives you the ids and the definitions:
let id: &str = content::Blocks::RUBY_ORE;          // "mymod:ruby_ore"
let def: yog_api::BlockDef = content::Blocks::ruby_ore();
```

For a block or item with behavior, mark it `"register": "manual"` and
register its definition yourself, adding what you need:

```rust
use crate::content::Items;

pub fn register(registry: &mut yog_api::Registry) {
    registry.register_item(Items::thehexbook() /* .on_use(...) etc. */);
}
```

## Import

```sh
yog import resourcepack <pack.zip|dir> --model mymod:block/ruby_ore   # one model
yog import resourcepack <pack.zip|dir> --all                         # every block and item
yog import bbmodel model.bbmodel [--id name] [--item]
```

Textures are copied into `resources/` and referenced by path; existing files
are kept unless `--force`. Yog-IDLE: **Project › Import…**. Blockbench
import supports Java Block/Item models (cubes; per-face UVs, rotations
within Minecraft's limits); meshes, animations and bones' transforms are
not imported.

## The editor

Opening a `.yblock`/`.yitem` shows the model editor; **F7** (or the code
button) shows the JSON, and Open With switches back.

- **View** — middle mouse (or Alt+left / right) orbits, Shift+middle pans,
  the wheel zooms; numpad 1/3/7 front/right/top (Ctrl: back/left/bottom),
  5 perspective/orthographic, 4/6/8/2 step the orbit, 0 or `.` recenters.
  The grid shows the block's 16×16 floor and bounds, N marks north.
  **Shading** toggles Minecraft's per-face brightness. Textures are drawn
  with nearest filtering; animated ones show their first frame.
- **Elements** — the outliner lists them; click one in the list or the view
  (clicking selects the face too). **Move** (G) and **Resize** (S) show axis
  handles; dragging snaps to whole pixels, Shift to quarter pixels, Ctrl
  turns snapping off. Ctrl+D duplicates, Delete deletes, Ctrl+C/V copies
  elements as JSON. A template's or parent's elements are shown; editing one
  copies them into the model.
- **Properties** — the block/item properties, the model (parent, textures with
  pickers listing `.yres` images, `resources/` and `assets/` pngs and vanilla
  textures), the selected element (rotation limited to what Minecraft allows)
  and face, display transforms and block states.
- **UV** — the selected face's rectangle on its texture; drag to move, drag
  an edge or corner to resize. **Auto UV** returns to the position-based UV.
- **Display** — preview a display slot (gui, ground, fixed, head, hands) with
  a reference frame and edit its rotation/translation/scale.
- **Variants** — with `states.rotations`, preview each variant.
- **Item Model** / **Connection Arm** — switch which model is edited (the arm
  is drawn over a translucent block).
- **Paint** (P) — paint the textures, on the model in the 3D view or in the
  2D texture view next to it (wheel zooms, middle/right drag pans, Home
  fits; the selected element's faces are outlined on their texture). Tools:
  pencil (B), eraser (E), fill (F; connected area or every pixel of that
  color), color picker (I, or Alt+click in the 2D view), line (L), rectangle (R; outline or
  filled); brush size 1–4 (`[` `]`), mirror X (M), a pixel grid; the color
  with alpha (or hex `#rrggbbaa`), a palette (+ adds, right-click removes)
  and recent colors. **New Texture…** puts a blank 16/32/64 px texture in
  the painted slot. A texture that isn't the mod's (`minecraft:item/apple`,
  say) is copied into the mod on the first stroke — `resources/item/<file>.png`
  (`block/` for blocks, `_<slot>` when the model has several slots) — and
  the slot points to the copy. Painted textures are written when the file is
  saved (Save, Save All); they mark it unsaved meanwhile. A texture changed
  on disk reloads when the window regains focus, unless it has unsaved paint.
- **Sprite items** (`generated`/`handheld`) open in Paint: the left pane lists
  the layers (add, remove, reorder; the color chip previews a tint for that
  layer's tint index). **Convert to 3D Elements** turns the sprite into
  elements of the model's own — one 1px-thick element per rectangle of
  opaque pixels — keeping the display transforms, so it can be shaped with
  Move/Resize.
- Undo/redo (Ctrl+Z / Ctrl+Y) step over the file's text and the painted
  pixels together; saving regenerates the Rust code (`yog content check`).

New files: **Add › New Item › Block / Item / Block with Item**.

## Limitations (v1)

- No block state properties beyond random rotations and connections
  (no facing/axis placement, slabs, stairs, doors yet).
- No silk-touch or fortune loot; no rarity or creative tab.
- `render_layer` is written as the model's `render_type` — honored by
  NeoForge/Forge; on Fabric the block renders solid (cutout pixels show
  black) until the loader maps it.
- Two mods' tags with the same name in one merged pack can collide.
- Animated textures are previewed on their first frame only.

## Recipes (`.yrecipe`)

One recipe per file, anywhere under `content/` (`content/recipes/` by
convention). Its id is `<mod id>:<file name>` unless the file says `"id"`.
IDLE opens it as a crafting table (the JSON is a click away).

```jsonc
// shaped: a pattern of key characters (space = empty), 1–3 rows of 1–3
{ type: "shaped", pattern: ["ISI", " S "],
  key: { I: "@item:minecraft:iron_ingot", S: "@item:minecraft:stick" },
  result: "@item:mymod:hammer" }

// shapeless: 1–9 ingredients in any arrangement; an ingredient may be a
// list — any of them does
{ type: "shapeless", ingredients: ["@item:minecraft:paper", ["@tag:item:c:dusts", "@item:minecraft:sugar"]],
  result: "@item:mymod:note", count: 2 }

// smelting (blasting, smoking, campfire_cooking): one ingredient;
// experience (default 0.1), cook_time in ticks (the station's default)
{ type: "smelting", ingredient: "@tag:item:c:ores", result: "@item:mymod:ingot", experience: 0.7 }

// stonecutting: one ingredient; smithing: template, base, addition
{ type: "smithing", template: "@item:minecraft:netherite_upgrade_smithing_template",
  base: "@item:mymod:ruby_sword", addition: "@item:minecraft:netherite_ingot", result: "@item:mymod:dark_sword" }

// the mod's own kind, for its machines and books: named slots and values
{ type: "mymod:infusion", slots: { core: ["@item:minecraft:diamond"], ring: ["@tag:item:c:dusts"] },
  values: { time: 200 }, result: "@item:minecraft:emerald" }
```

A recipe is Yog Data (comments, trailing commas, unquoted names are
fine). Items are references — `@item:minecraft:paper`, a tag
`@tag:item:c:dusts` — so a bare `minecraft:paper` is an error that says
how to write it. `yog build` checks every item a recipe names — the mod's
own, Minecraft's on every version Yog supports, other mods' ids declared
in `yog.toml` — and registers every recipe, no code needed. IDLE lays out
shaped, shapeless and smelting recipes as a crafting table; other kinds
open as code.

### Recipe layouts (`.ylayout`)

How a book shows a kind of recipe is data too. The game's kinds have
built-in layouts (Patchouli's crafting grid, furnace and smithing strips);
a mod lays out its own kind in `content/<kind>.ylayout` — a book page
showing a recipe of a kind with no layout is a build error:

```jsonc
// content/infusion.ylayout
{
  kinds: ["mymod:infusion"],
  size: [96, 60],                        // GUI pixels
  parts: [
    { type: "image", source: "mymod:gui/altar", uv: [0, 0, 96, 60] },  // optional picture
    { type: "slots", slot: "ring", at: [[22, 4], [42, 22], [22, 40], [2, 22]], frame: true },
    { type: "slots", slot: "core", at: [[22, 22]], frame: true },
    { type: "item", item: "@item:minecraft:beacon", at: [56, 4] },     // the station
    { type: "result", at: [76, 22], frame: true },
    { type: "count", at: [78, 40] },                                    // when more than one
    { type: "text", text: "{time} ticks", at: [52, 44] },               // the recipe's values
  ],
}
```

A slot's ingredients fill its places in order; the game's kinds name
theirs `grid` (crafting), `input` (cooking, stonecutting) and
`template`/`base`/`addition` (smithing), and a mod's layout for one of
them replaces the built-in one. `{name}` in a text is the recipe's value:
`time`, `experience`, or a mod kind's `values`.
