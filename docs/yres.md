# `.yres` resource files

A `.yres` file is a set of a mod's resources — what a C# project keeps in
`Resources/*.resx`: texts shown to the player (translated per language),
images, sounds, other files, colors, numbers and flags, each under a name
with an optional comment. It is the one home for a mod's resources: `yog
build` turns the texts into Minecraft lang files, bundles the files into
the right `assets/<mod id>/...` paths, and generates typed accessors
(`Strings::screen_title()`, `Icons::logo()`), the way Visual Studio
generates `Resources.Designer.cs`. `.yui` screens and `yog.toml` refer to
entries as `@<File>.<name>`.

Yog-IDLE opens `.yres` files in a table editor (Name | Value | Type |
Comment) like Visual Studio's ResX designer, with a column per language;
the JSON stays available through **View Code** (F7). See
[In Yog-IDLE](#in-yog-idle).

## Where they go

```
mymod/
  yog.toml
  resources/
    Strings.yres          ← neutral (English, en_us) texts and other resources
    Strings.ru_ru.yres    ← Russian texts
    Strings.ja_jp.yres
    Icons.yres
    Items.yres
    images/logo.png       ← files the entries point at
    item/ruby.png
    sounds/click.ogg
  src/...
```

`yog build` reads every `resources/**/*.yres`. A file's **resource set** is
its name without the locale and extension: `Strings.yres` (the neutral
file, its texts are `en_us`) and its *culture variants*
`Strings.<locale>.yres` (`ru_ru`, `pt_br`, ... — Minecraft's lower-case
locale codes) are the set `Strings`. A set name is an identifier
(`Strings`, `Icons`, `MenuTexts`) and unique in the mod, whatever
subfolder of `resources/` it's in. A culture variant without a neutral
file is an error; so is `Strings.en_us.yres` (the neutral file *is* en_us).

## Format

One Yog Data object (UTF-8, 2-space indented by the editor) — JSON, plus
`//` and `/* */` comments, trailing commas and unquoted names, like every
Yog format. Entry names map to values, in the order shown in the editor. A
text starting with `@` is written `@@` (`"@@home"` is the text `@home`): a
single `@` starts a reference everywhere in Yog Data, and a text entry
can't be one. Saving from the grid view rewrites the file, so comments
survive only edits in the code view.

```json
{
  "mod_name": "Mod List",
  "screen.title": { "value": "Yog Mods", "comment": "Title of the mod list screen" },
  "mods_count": { "value": "{count} mods", "comment": "{count}: number of mods" },
  "logo": { "type": "image", "value": "images/logo.png" },
  "accent": { "type": "color", "value": "#FF8800" },
  "rows_per_page": { "type": "number", "value": 20 },
  "show_badges": { "type": "bool", "value": true }
}
```

An entry is either a string (a text) or an object:

| Field | Meaning |
|---|---|
| `value` | Required. The text, path, color, number or flag. |
| `type` | `string` (default), `image`, `file`, `sound`, `color`, `number`, `bool`. |
| `comment` | A note for translators and other developers; never shipped. |
| `key` | Texts only: the translation key, instead of the default one. |
| `texture` | Images only: the texture path under `assets/<mod id>/textures/`, instead of the default one. |
| `event` | Sounds only: the sound event name, instead of the default one. |
| `subtitle` | Sounds only: the subtitle's translation key (a text entry's `key`, or any key). |

Bare `123`/`true` values are accepted as `number`/`bool` entries too.

**Names** are identifiers, optionally dotted: `title`, `mods_count`,
`screen.title`, `ruby.tooltip` (letters, digits and `_`, each part not
starting with a digit). Each becomes a Rust accessor in snake case
(`screen.title` → `screen_title`, `ModName` → `mod_name`); two names giving
the same accessor are an error.

### Types

| Type | Value | `yog build` | Accessor |
|---|---|---|---|
| `string` | text, with [placeholders](#placeholders) | into `assets/<mod id>/lang/<locale>.json` under its [key](#translation-keys) | `fn name(args…) -> String` — the text in the player's language; `const NAME_KEY: &str` |
| `image` | a `.png` path, relative to the `.yres` file | copied to `assets/<mod id>/textures/<texture>.png`, `<texture>` = the path relative to `resources/` without `.png` (or `texture`) | `const fn name() -> &'static str` — the image source `<mod id>:<texture>` (see `yog_gfx::image`), for `Image`, `Draw2D::image`, item models (`item/ruby` is the texture an item model of item `ruby` uses) |
| `file` | a path, relative to the `.yres` file | copied to `assets/<mod id>/<path relative to resources/>` | `const fn name() -> &'static str` — its resource id `<mod id>:<path>` |
| `sound` | an `.ogg` path, relative to the `.yres` file | copied to `assets/<mod id>/sounds/<path relative to resources/, no .ogg>`, plus a `sounds.json` event `<event>` (default: the name, lower case) playing it | `const fn name() -> &'static str` — the sound event id `<mod id>:<event>` |
| `color` | `#RRGGBB` or `#AARRGGBB` | — | `const NAME: u32` (`0xAARRGGBB`; `#RRGGBB` is opaque) |
| `number` | a JSON number | — | `const NAME: i64` for an integer, `f64` otherwise |
| `bool` | `true`/`false` | — | `const NAME: bool` |

Paths must stay inside `resources/`, and the files must exist. A
`sounds.json` of your own in `assets/<mod id>/` is merged with the generated
one; the same event in both is an error.

### Translation keys

A text's key in the lang files (what `Text.translatable`, `/tellraw` and
other mods see) is its `key`, or by default:

| Set | Key |
|---|---|
| `Items` | `item.<mod id>.<name>` — so `"ruby": "Ruby"` in `Items.yres` names item `<mod id>:ruby`, `"ruby.tooltip"` gives `item.<mod id>.ruby.tooltip` |
| `Blocks` | `block.<mod id>.<name>` |
| `Entities` | `entity.<mod id>.<name>` |
| anything else | `<mod id>.<name>` |

Registering an item or block thus needs no lang file. The same key from
two entries (of any sets) is an error, and so is a key that a hand-written
`assets/<mod id>/lang/<locale>.json` also defines (the rest of such a file
is merged in).

### Placeholders

Texts take arguments as `{name}` or `{0}`, `{1}`, … (one style per text);
`{{` and `}}` are literal braces, and `%` is a literal percent sign. In the
lang file they become Minecraft's `%1$s`, `%2$s`, … (and `%%`), so
`Text.translatable(key, args)` fills them too. The accessor takes one
`impl Display` parameter per placeholder, in order of first appearance
(`{0}`, `{1}`: `arg0`, `arg1`):

```json
"mods_count": "{count} mods",
"shown_of": "Showing {shown} of {total}"
```

```rust
Strings::mods_count(58)          // "58 mods" / "Модов: 58"
Strings::shown_of(3, 58)
```

A translation may reorder the placeholders and leave some out; one the
neutral text doesn't have is an error.

### Culture variants

`Strings.ru_ru.yres` holds the same set's texts in another language, under
the same names — texts only (an image, color, ... there is an error), and
`key` comes from the neutral file. A name the neutral file doesn't have
gets a warning and is left out. A text missing from a variant, or empty
there, isn't written to that locale's lang file, so the game shows the
neutral (en_us) text — `yog build` warns about each, and so does
`yog res check`, which lists them per locale without building.

## Mod metadata

`yog.toml`'s `[mod]` `name` and `description` may be texts, and `icon` an
image:

```toml
[mod]
id = "mymod"
name = "@Strings.mod_name"
description = "@Strings.mod_description"
icon = "@Icons.logo"
```

The packaged `.yog` gets the neutral texts as `name`/`description` plus
their keys (`name_key`, `description_key`) and the image source as `icon`;
the loader shows the name and description in the player's language (the
mod list, `yog_api` `mods_list()`).

## In code

```rust
// src/lib.rs
yog_api::resources!();
```

— once, in `lib.rs` — declares module `res` (`crate::res`) with one unit
struct per resource set: `Strings` for `resources/Strings.yres`, `Icons` for
`resources/Icons.yres`, … (the struct is named after the file, so set names
must be unique across `resources/` and its folders). Nothing to add per set.

`yog build`, `yog check` and `yog res check` (yog-cli 0.27.2+, yog-api
0.89.2+) generate the code, never committed and never stale:

- `.yog-build/generated/resources/<Set>.g.rs` — one file per set, with an
  `// <auto-generated>` banner. Yog-IDLE shows it under the set's neutral
  `.yres` in Project Explorer and opens it read-only, like
  `Resources.Designer.cs` under a `.resx`.
- `.yog-build/generated/resources.g.rs` — `include!`s every set's file;
  this is what `resources!()` includes inside `mod res`.

Each entry becomes an associated function or constant, documented like
`Resources.Designer.cs` — what it holds (for texts, the neutral value), then
the name, the comment and where it's defined:

```rust
// .yog-build/generated/resources/Strings.g.rs
pub struct Strings;
impl Strings {
    /// Translation key of [`Self::screen_title`]: `mymod.screen.title`.
    pub const SCREEN_TITLE_KEY: &'static str = "mymod.screen.title";
    /// Looks up a localized string similar to "Yog Mods".
    ///
    /// `screen.title` — Title of the mod list screen (resources/Strings.yres:4)
    pub fn screen_title() -> String { ::yog_api::tr(Self::SCREEN_TITLE_KEY) }
    pub const MODS_COUNT_KEY: &'static str = "mymod.mods_count";
    /// Looks up a localized string similar to "{count} mods".
    pub fn mods_count(count: impl Display) -> String { ::yog_api::tr_args(Self::MODS_COUNT_KEY, &[&count]) }
}

// .yog-build/generated/resources/Icons.g.rs
pub struct Icons;
impl Icons {
    /// The image `images/logo.png`.
    pub const fn logo() -> &'static str { "mymod:images/logo" }   // image/file/sound: a source / id
    /// The color `#FF8800`.
    pub const ACCENT: u32 = 0xFFFF8800;                             // color
    /// The number `20`.
    pub const ROWS_PER_PAGE: i64 = 20;                              // number
    /// The flag `true`.
    pub const SHOW_BADGES: bool = true;                             // bool
}
```

```rust
use crate::res::{Icons, Strings};

label(Strings::screen_title());
label(Strings::mods_count(mods.len()));
image(Icons::logo());
register_menu_entry(Strings::MENU_BUTTON_KEY, "mymod:main"); // takes a key
```

Texts are looked up on each call (`yog_api::tr`/`tr_args`), so call them
when building the UI, not once at startup — the player can switch language
at any time. Without the accessors, `yog_api::tr("mymod.screen.title")` and
`yog_api::tr!("mymod.mods_count", n)` do the same by key
(`yog_api::translation(key)` gives `None` for an unknown one).

## In `.yui` screens

A `text` or `placeholder` attribute starting with `@` is a resource:

```xml
<Label text="@Strings.screen.title" />    <!-- a .yres text -->
<Label text="@lang:gui.done" />           <!-- any translation key -->
<Label text="@item:minecraft:stick" />    <!-- an item's (block's, entity's) name -->
<Label text="@@home" />                   <!-- the literal text "@home" -->
<Image source="@Icons.logo" />            <!-- a .yres image -->
```

`@<Set>.<name>` is an entry of `resources/<Set>.yres` (its `key`, or its
image source); `@lang:` takes any translation key exactly as the lang files
have it, the game's or a mod's; `@item:`/`@block:`/`@entity:` show that
content's name. Any other `@…` is an error (`@gui.done` says to write
`@lang:gui.done`) — the same grammar as every Yog format. The
designer shows the text in the IDE's language (falling back to the neutral
file), the build looks it up in the player's.

## In Yog-IDLE

- **Add → New Item → Resources File** creates `<Name>.yres` (`Strings.yres`
  by default) and **Language File** `Strings.<locale>.yres`
  (`Strings.ru_ru.yres` by default) — in `resources/` (made if missing) when
  added on the project itself, else in the chosen folder. Project Explorer
  shows `resources/` and `.yres` files with their own icons, and a set's
  culture variants nested under its neutral file.
- `.yres` files open in the resource editor: a grid of Name | Value | Type
  | Comment (a culture variant: Name | Value | Comment, with the neutral
  texts in a read-only column beside them). Double-click, F2 or just start
  typing to edit a cell; Enter commits and moves down, Tab to the next
  cell, Esc cancels; the empty row at the bottom adds an entry. Values are
  edited by type: text, a `#AARRGGBB` field with a color picker, a path
  with a **…** file picker (images show a thumbnail), a number, a checkbox
  for flags; the Type cell is a drop-down. Delete removes the selected
  rows; Ctrl+C/Ctrl+X/Ctrl+V copy rows as tab-separated Name, Value, Type,
  Comment (pasting two or three columns from a spreadsheet works too). The
  search box filters by name, value, comment or translation. Empty,
  invalid and duplicate names (or names giving the same accessor) and
  values that don't fit their type are marked red, with the reason in the
  cell's tooltip; empty texts are highlighted.
- **All Languages** adds a column per culture variant of the set (edited
  in place — the change goes to that file's open tab, or straight to
  disk); untranslated cells are highlighted. Renaming or deleting an entry
  there does the same in every culture. **Add Language…** creates
  `<Set>.<locale>.yres` with every text of the set, still to translate.
- Undo/Redo, Save, dirty marks and reload on external change work as for
  any document. Saving a `.yres` runs `yog res check`, regenerating
  the set's `<Set>.g.rs` (nested under the `.yres`, read-only) for the code (errors show as a notification). **View Code**
  (F7, or the toolbar's code button) switches the tab to the JSON.
- The screen designer shows `@Strings.title` and `@<key>` texts from the
  mod's `.yres` files in the IDE's language (the matching culture variant,
  else the neutral text), and `source="@Icons.logo"` as the bundled
  image.
