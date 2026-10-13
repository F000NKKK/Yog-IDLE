# View-model screens (yog-kit)

A `.yui` screen whose root has `x:ViewModel="MyVm"` compiles into a
[`yog-kit`](https://crates.io/crates/yog-kit) view instead of the plain
`build()`/`render()` functions described in [yui.md](yui.md). The markup
holds the layout **and** the wiring (`{x:Bind ...}` bindings, commands,
lists); the code-behind holds a plain Rust struct with the screen's state
and logic. Rendering, hit-testing, scrolling, text boxes, focus, keyboard
navigation, list virtualization and selection are all handled by yog-kit.

The mod needs the dependency in `yog.toml`:

```toml
[dependencies]
yog-kit = "0.2"
```

`yog build --local-api` (or `YOG_API_PATH`) also points yog-kit at the
local checkout.

Any layout element works in a view-model screen, including
[`<Grid>`](yui.md#grid): a header/content/footer split or a list next to a
details pane is one `Grid` with `rows`/`columns` instead of nested
`Row`/`Column` stacks (see `Yog-Modlist/src/mod_list.yui`).

## Example

```xml
<Screen id="mymod:counter" width="160" height="60" x:ViewModel="CounterVm">
    <Screen.Resources>
        <Color x:Key="Accent" value="#FFD700"/>
        <Style x:Key="Btn" target="Button" w="40" h="14" bg="#FF333333" hover:bg="#FF555555"/>
    </Screen.Resources>
    <Column w="100%" h="100%" padding="6" gap="4">
        <Label x:Name="count" text="{x:Bind count_text()}" color="@Accent"/>
        <TextBox x:Name="name" w="100%" h="14" text="{x:Bind name, Mode=TwoWay}" placeholder="@Strings.name_hint"/>
        <Row gap="4">
            <Button x:Name="add" style="@Btn" text="+1" command="{x:Bind add(1)}"/>
            <Button style="@Btn" text="@Strings.close" command="{x:Bind cx.close()}"/>
        </Row>
    </Column>
</Screen>
```

```rust
// src/counter.rs
yog_api::ui_include!("counter");

use yog_kit::prelude::*;

#[derive(Default)]
struct CounterVm {
    count: u32,
    name: String,
}

impl ViewModel for CounterVm {}

impl CounterVm {
    fn count_text(&self) -> String {
        format!("{}: {}", self.name, self.count)
    }
    fn add(&mut self, n: u32) {
        self.count += n;
    }
}
```

```rust
// lib.rs, in Mod::register
counter::register(registry);          // -> ScreenHandle<CounterVm>
registry.register_menu_entry("Counter", counter::ID);
```

## Generated API

The generated `.g.rs` (pulled in by `ui_include!`) defines:

- `ID`, `WIDTH`, `HEIGHT` and `mod ids` (one `&str` per `x:Name`/`id`);
- a private `View` implementing `yog_kit::View` (`type Vm = CounterVm`);
- `register(registry) -> ScreenHandle<Vm>` — the view model comes from
  `x:Create="expr"` on the `<Screen>`, or `Default`;
- `register_with(registry, vm)`, `handle()`;
- `open()` and `close()`.

A `ScreenHandle` is `Clone + Send`: `handle.update(|vm| ...)` changes the
view model from anywhere (a packet handler, another thread) and the screen
redraws on the next frame; `handle.read(|vm| ...)` reads it.

## `ViewModel`

Every hook is optional:

| Hook | When |
|---|---|
| `on_open(&mut self, cx)` | the screen opened (load data here — every mod has loaded by then) |
| `on_close(&mut self, cx)` | it closed |
| `on_back(&mut self, cx) -> bool` | Esc with nothing focused; `true` keeps the screen open |
| `customize(&self, root)` | after the bindings, before layout — last-resort tree tweaks |

`Cx` (in commands and hooks): `close()`, `navigate(id)` /
`navigate_to::<OtherView>(|vm| ...)` (opens another screen and sets up its view model), `back()`, `focus(id)`, `handle()`, `invalidate()`.

## Bindings

`attr="{x:Bind expr[, Mode=OneWay|TwoWay|OneTime][, BindBack=method][, Fallback=value]}"`

`expr` is a small expression language, compiled to Rust (type errors point
at the `.yui` line via `// @yui file:line` comments in the generated code):

- paths and calls: `count`, `count_text()`, `state.name`, `has(Filter::Yog)`;
  bare names are fields/methods of the view model (in item templates: of
  the item; write `vm.x` for the view model there);
- `Type::f(args)` — `Strings::details_id(id)`; field arguments are passed
  by reference (`&vm.id`);
- literals `1`, `1.5`, `true`, `'text'`; `!x`, `a == b`, `a != b`;
- `a?.b` — `None` anywhere gives the `Fallback` (or the default).

Anything else belongs in a view-model method. Bindings are re-evaluated
every frame the view model changed; a widget is only patched when its
value did.

| Attribute | Value |
|---|---|
| `text` (Label, Button, TextBox), `placeholder`, `item`, `source` | anything `Display` |
| `bg`, `color`, `focus_color` | `u32` `0xAARRGGBB` |
| `enabled`, `visible`, `checked` (Button/ToggleButton) | `bool` |
| `w`, `h` | `Into<Units>` (`f32` = pixels) |
| `gap`, `flex`, `font_scale`, `min_w`, `min_h` | number |
| `count` (InvSlot) | integer |
| `scroll_key` (ScrollView, ListView) | anything `Hash`; the view scrolls to the top when it changes |

`text="@Strings.name"` (a `.yres` text) is looked up on every update, so it
follows the game language.

**Two-way:** `TextBox text="{x:Bind search, Mode=TwoWay}"` writes typed
text back to the field (or calls `BindBack=method(String)`);
`ToggleButton checked="{x:Bind dark, Mode=TwoWay}"` flips the field when
clicked.

## Commands

`command="{x:Bind method(args)}"` on a Button/ToggleButton (or any element:
it becomes clickable and focusable) calls the view model; `cx.close()` and
other `Cx` calls work too. On a TextBox the command runs on Enter. In item
templates commands must start with `vm.` or `cx.` — item fields in the
arguments are cloned out of the clicked item: `command="{x:Bind vm.remove(id)}"`.

`on_click`/`on_change`/`on_submit` aren't allowed in view-model screens.

## Lists

```xml
<ListView w="100%" flex="1" items="{x:Bind visible()}" key="{x:Bind id}"
          selected="{x:Bind selected_id(), BindBack=select}" item_height="24">
    <ListView.ItemTemplate>
        <DataTemplate x:DataType="ModEntry">
            <Column w="100%" selected:bg="#883A3A5A">
                <Label text="{x:Bind name}"/>
            </Column>
        </DataTemplate>
    </ListView.ItemTemplate>
    <ListView.Empty>
        <Label text="{x:Bind empty_text()}"/>
    </ListView.Empty>
</ListView>
```

- `ListView` — a scrolling, virtualized, selectable list: only the rows in
  view exist (with `item_height`; rows must be that tall). Click or
  Up/Down/PageUp/PageDown/Home/End select; the selected row is revealed.
  `items` is anything `IntoIterator` (`&Vec<T>`, an iterator method);
  `key` identifies a row across updates (default: its index); `selected`
  compares with `key` (`Option<K>`); the selection goes back through
  `BindBack=method(K)` or `Mode=TwoWay` (`Option<K>` field).
- `ItemsControl` — the same without scrolling or selection
  (`orientation="horizontal"` for a row).
- `ContentPresenter content="{x:Bind selected()}"` — shows its template
  for an `Option<T>` (or nothing / `ContentPresenter.Empty`).

The selected row (and its non-interactive children) gets the SELECTED
state.

## Styles and states

`<Screen.Resources>` holds `<Color x:Key="Name" value="#..."/>` (any
attribute value `@Name` refers to it) and
`<Style x:Key="Name" target="Button" based_on="@Other" attr="..."/>`
(applied with `style="@Name"`; the element's own attributes win).

Paint attributes take a state prefix: `hover:`, `pressed:`, `focused:`,
`selected:`, `checked:`, `disabled:` on `bg`, `color`, `shadow`,
`focus_color` — e.g. `hover:bg="#FF555555" checked:bg="#FF777777"`.

`ToggleButton` is a Button whose `checked` drives the CHECKED state.

## Keyboard

Tab / Shift+Tab move focus between commands, text boxes and lists; Enter
or Space activate the focused button; Esc leaves a focused text box first,
then asks `on_back`, then goes back (after `navigate`) or closes the
screen.

## Testing

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use yog_kit::testing::TestHost;

    #[test]
    fn adds() {
        let mut h = TestHost::<View>::new(CounterVm::default());
        h.open();
        h.click_id(ids::ADD);
        assert_eq!(h.vm().count, 1);
        h.type_into(ids::NAME, "x");
        assert_eq!(h.text(ids::COUNT).as_deref(), Some("x: 1"));
    }
}
```

`TestHost` runs the real view without the game: `click_id`, `click_path`,
`key`, `type_into`, `scroll`, `move_to`, `vm`/`vm_mut`, `text`, `state`,
`is_visible`, `rect`, `closed()`... Run the tests with `cargo test` in
`.yog-build/`.

Yog-Modlist (`src/mod_list.yui` + `src/mod_list.rs`) is a complete example:
a two-way search box, filter toggles, a virtualized selectable list with an
empty state and a details pane.
