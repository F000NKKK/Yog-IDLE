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

One JSON object (UTF-8, 2-space indented by the editor); entry names map
to values, in the order shown in the editor:

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

declares module `res` (`crate::res`) from `.yog-build/generated/res.g.rs`
— written by `yog build`, `yog check` and `yog res check`, never committed
— with a unit struct per resource set and an associated function or
constant per entry (yog-cli 0.26.1+, yog-api 0.88.1+):

```rust
pub struct Strings;
impl Strings {
    /// Translation key of [`Self::screen_title`]: `mymod.screen.title`.
    pub const SCREEN_TITLE_KEY: &'static str = "mymod.screen.title";
    /// `screen.title` — Title of the mod list screen
    ///
    /// Neutral text: "Yog Mods".
    pub fn screen_title() -> String { ::yog_api::tr(Self::SCREEN_TITLE_KEY) }
    pub const MODS_COUNT_KEY: &'static str = "mymod.mods_count";
    pub fn mods_count(count: impl Display) -> String { ::yog_api::tr_args(Self::MODS_COUNT_KEY, &[&count]) }
}
pub struct Icons;
impl Icons {
    pub const fn logo() -> &'static str { "mymod:images/logo" }   // image/file/sound: a source / id
    pub const ACCENT: u32 = 0xFFFF8800;                             // color
    pub const ROWS_PER_PAGE: i64 = 20;                              // number
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
<Label text="@minecraft.gui.done" />      <!-- any translation key -->
<Label text="@@home" />                   <!-- the literal text "@home" -->
<Image texture="@Icons.logo" />           <!-- a .yres image -->
```

`@<Set>.<name>` is an entry of `resources/<Set>.yres` (its `key`, or its
image source); anything else after `@` is a translation key as is. The
designer shows the text in the IDE's language (falling back to the neutral
file), the build looks it up in the player's.

## In Yog-IDLE

- **Add → New Item → Resources File** creates `resources/<Name>.yres`
  (`Strings.yres` by default); **Language File** creates
  `resources/Strings.<locale>.yres`. Project Explorer shows `resources/`
  with its own icon, and the culture variants nested under their neutral
  file.
- The editor is a grid: Name | Value | Type | Comment. Double-click, F2
  or just start typing to edit a cell; Enter commits and moves down, Tab
  to the next cell, Esc cancels; the empty row at the bottom adds an entry.
  Values are edited by type: a color picker, an image/file picker (with a
  thumbnail for images), a number field, a checkbox. Delete removes the
  selected rows; Ctrl+C/Ctrl+X/Ctrl+V copy rows as tab-separated text
  (to and from a spreadsheet). The search box filters by name, value or
  comment. Empty and duplicate names are marked red.
- **All Languages** adds a column per culture variant; untranslated cells
  are marked. **Add Language…** creates `<Set>.<locale>.yres` with every
  text of the set, still to translate.
- Undo/Redo, Save, dirty marks and reload on external change work as for
  any document; **View Code** (F7) shows the JSON.
