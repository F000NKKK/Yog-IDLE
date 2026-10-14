# Guide books (`.ybook`)

A guide book is a file in `content/`: `yog build` checks it and registers
it with the mod's blocks and items — no code. Its `id` is the item that
opens it (`"guide"` = `<mod id>:guide`; make that item a `.yitem`).

```json
{
  "id": "guide",
  "name": "@Book.title",
  "version": 1,
  "categories": [{ "id": "mymod:basics", "name": "@Book.basics", "icon": "@item:mymod:ruby" }],
  "entries": [
    {
      "id": "mymod:ruby",
      "name": "@item:mymod:ruby",
      "category": "@category:mymod:basics",
      "icon": "@item:mymod:ruby",
      "pages": [
        { "type": "spotlight", "item": "@item:mymod:ruby", "text": "@Book.ruby.intro" },
        { "type": "recipe", "recipe": "@recipe:mymod:ruby_block" },
        { "type": "entity", "entity": "@entity:minecraft:allay", "name": "@Book.allay" }
      ]
    }
  ]
}
```

## References

A book names what it shows by reference, never by a bare game id:

| Write | Names |
|---|---|
| `@item:minecraft:stick` | an item (a block's item too) |
| `@block:minecraft:furnace[facing=north]` | a block, with an optional state |
| `@entity:minecraft:allay` | an entity |
| `@recipe:mymod:ruby_block` | a recipe |
| `@entry:mymod:ruby` | an entry of this book |
| `@category:mymod:basics` | a category of this book |

`yog build` checks every reference: the mod's own content must exist,
vanilla ids must exist **on every Minecraft version Yog supports**
(`minecraft:short_grass` is only in 1.21.1, so it's an error), and ids of
other mods — original Java mods or Yog mods — must be declared up front
in `yog.toml`:

```toml
[external.farmersdelight]
items = ["cutting_board", "tomato"]
blocks = ["stove"]
entities = []
recipes = []
```

The game gets plain ids. Fields that take references: `entries[].category`
(`@category:`), `icon` of categories and entries (`@item:`/`@block:`, or an
image as is: `minecraft:textures/item/book.png`), `spotlight.item`,
`recipe.recipe`, `entity.entity`, `multiblock.mapping` values (`@block:`),
`relations.entries` (`@entry:`).

## Texts

Any text may be a reference too — the book then shows in the player's
language without translating it twice:

| Write | Shows |
|---|---|
| `@Book.title` | the text `title` of `resources/Book.yres` (any `.yres` set) |
| `@item:mymod:ruby`, `@block:…`, `@entity:…` | its name, from the game's language files |
| `@@text` | `@text`, literally |

Texts are Yog text — the format of `.yres` and screens:

| Write | Shows |
|---|---|
| `{b\|bold}`, `{i\|…}`, `{u\|…}`, `{s\|…}` | bold, italic, underlined, struck out |
| `{#8d6acc\|…}` | that color; words combine: `{b #8d6acc\|…}`; spans nest |
| `{accent\|term}` | the book's `accent` color |
| `{link=@entry:mymod:ruby\|text}` | a link to an entry (checked like any reference) |
| `{link=https://…\|text}` | a link to a web page |
| `{{`, `}}` | `{`, `}` |

## The book's look

`book_texture` is the book's sheet (Patchouli's layout, e.g.
`mymod:textures/gui/book.png`; Yog's own by default), `nameplate_color`
the title's color, `accent` the color of `{accent|…}`, `landing_text`
the text on the first page. The nameplate's second line is the edition —
`"version": 1` shows "1st Edition" — or, with no version, the `subtitle`.

## Pages

| `type` | Shows |
|---|---|
| `text` | `text`, an optional `title`; another `font` (a resource-pack font — `assets/<ns>/font/<name>.json`, e.g. a `ttf` provider) `font_size` pixels a line |
| `spotlight` | the item `item`, its `title` (or name) and `text` |
| `recipe` | the recipe `recipe` as its station shows it — a crafting grid, a furnace — and `text` |
| `image` | the image `texture` (a Yog image source, `.svg` too), `title`, `text` |
| `entity` | the living entity `entity`, turning slowly; `name`, `text` |
| `multiblock` | the structure `pattern` (layers top to bottom, rows of letters) with `mapping` (letter → block), turning slowly; `name`, `text` |
| `pattern` | a spell pattern: `name` (or `op_id`), the `patterns` drawn on a hexagonal grid (`{ "startdir": "NORTH_EAST", "signature": "qaq" }`), `input` → `output`, `text` |
| `relations` | links to the entries `entries` |
| `empty` | nothing |

Entries may be `secret`, `read_by_default`, unlocked by an `advancement`,
and ordered by `priority`; categories by `sortnum`.

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
- **Language**: read the book in each language its texts are translated into;
- **the properties** of what's selected on the right.

Entities show as their spawn egg in the designer (it has no entity
models); the game draws them in 3D. The Code view (F7) is the JSON.
