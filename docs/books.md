# Guide books (`.ybook`)

A guide book is a file in `content/`: `yog build` checks it and registers
it with the mod's blocks and items — no code. Its `id` is the item that
opens it (`"guide"` = `<mod id>:guide`; make that item a `.yitem`).

```json
{
  "id": "guide",
  "name": "@Book.title",
  "author": "Me",
  "categories": [{ "id": "mymod:basics", "name": "@Book.basics", "icon": "mymod:ruby" }],
  "entries": [
    {
      "id": "mymod:ruby",
      "name": "@item:mymod:ruby",
      "category": "mymod:basics",
      "icon": "mymod:ruby",
      "pages": [
        { "type": "spotlight", "item": "mymod:ruby", "text": "@Book.ruby.intro" },
        { "type": "crafting", "recipe": "mymod:ruby_block" },
        { "type": "entity", "entity": "minecraft:allay", "name": "@Book.allay" }
      ]
    }
  ]
}
```

## References instead of copies

Any text may be a reference — the book then shows in the player's
language without translating it twice:

| Write | Shows |
|---|---|
| `@Book.title` | the text `title` of `resources/Book.yres` (any `.yres` set) |
| `@item:mymod:ruby` | that item's name, from the game's language files |
| `@block:stone` | that block's name |
| `@@text` | `@text`, literally |

## Pages

| `type` | Shows |
|---|---|
| `text` | `text`, an optional `title` |
| `spotlight` | the item `item`, its `title` (or name) and `text` |
| `crafting` / `smelting` | the recipe `recipe` and `text` |
| `image` | the image `texture` (a Yog image source, `.svg` too) |
| `entity` | the living entity `entity` (`minecraft:zombie`), turned toward the reader |
| `svg` | the SVG document `data` |
| `custom_text` | `text` in the font `font_id` (a resource-pack font — `assets/<ns>/font/<name>.json`, e.g. a `ttf` provider), `size_px` high, `color` |
| `relations` | links to the entries `entries` |
| `empty` | nothing |

Text that doesn't fit its page goes on to the next ones by itself, and
titles shrink to the page's width.

## The book designer

Opening a `.ybook` in Yog-IDLE shows the book drawn by yog-book itself —
the renderer the game runs, with the game's font and textures:

- **the outline** on the left: the book, its categories, entries and
  pages; add, remove and reorder them from the toolbar;
- **the book** in the middle, live: click it like a reader — categories,
  entries, the page arrows, home — and the outline follows; select a
  page in the outline and the book turns to it; every edit shows at once;
- **the properties** of what's selected on the right.

Entities show as their spawn egg in the designer (it has no entity
models); the game draws them in 3D. The Code view (F7) is the JSON.
