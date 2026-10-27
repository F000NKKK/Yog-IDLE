// What the Properties window shows for the widgets selected in the screen
// designer — one row per `.yui` attribute the selection can have.

import { pt, t, type PropertyDescriptor, type PropertyValue, type XmlSchema } from "substrate-platform-ui";
import { screenAnchor, yog, yui, yuiAttr, yuiComponent, yuiMarkup } from "../../data/yogIds.generated";
import { imageAlias, imagePreview, imageSources } from "../resources/imageSources";
import { CONTAINER_KINDS, cssColor, KIND_INFO, KINDS, parseColor, parseNumber, type YuiNode } from "./yui";
import { findComponent, type ComponentInfo, type ComponentsSnapshot } from "./components";
import { AXES, formatLength, gridDefs, parseLength, shiftCells, withGridDefs, type Axis } from "./grid";
import { editDefinitions } from "../view/GridAdorner";
import { colorRefs, designColor, designText, extractColor } from "../../lang/designResources";
import { modRootOf } from "../../project/paths";
import { gameId } from "../../data/yogFormat";
import { GAME_FONTS, gameFontNamedDirectly, offerFontCopy } from "../resources/fonts";

type AttrKind = "text" | "number" | "units" | "color" | "bool" | "enum" | "padding" | "uv" | "image" | "tracks" | "index" | "span";

interface AttrSpec {
  attr: string;
  /** English; shown through `t` (unless `raw`). */
  name: string;
  /** English (through `t` unless `raw`) — or a component's name. */
  category: string;
  /** Name, category and description are the mod's own (a component's properties), not translated. */
  raw?: boolean;
  kind: AttrKind;
  options?: readonly string[];
  /** What an absent attribute means (shown greyed as the value). */
  fallback?: string;
  description: string;
  /** Which kinds have it — all when omitted. */
  only?: readonly string[];
  /** Kinds that don't have it. */
  not?: readonly string[];
  /** Values offered in an editable combo box (any other text is accepted too). */
  suggestions?: readonly string[];
  /** A Grid's rows or columns — read and written in either form (`rows="..."` or `<Grid.RowDefinitions>`). */
  axis?: Axis;
  /** An attached property of a Grid's children (`Grid.Row`, ...): shown only for them. */
  attached?: boolean;
}

const TEXT_KINDS = [yui.LABEL, yui.BUTTON, yui.TEXT_BOX];
/** Text that wraps (a text box scrolls its one line instead). */
const WRAP_KINDS = [yui.LABEL, yui.BUTTON];
const ANCHORS = Object.values(screenAnchor);

const SPECS: AttrSpec[] = [
  { attr: yuiAttr.ID, name: "(Name)", category: "Design", kind: "text", description: "The widget's id — a constant in the generated `ids` module, and what `find_mut` looks it up by. The screen's own id is its UI id, `<modid>:<name>`." },
  { attr: yuiAttr.WIDTH, name: "Width", category: "Screen", kind: "number", fallback: "176", only: [yui.SCREEN], description: "The screen's width in GUI pixels." },
  { attr: yuiAttr.HEIGHT, name: "Height", category: "Screen", kind: "number", fallback: "166", only: [yui.SCREEN], description: "The screen's height in GUI pixels." },
  { attr: yuiAttr.THEME, name: "Theme", category: "Screen", kind: "enum", options: ["", gameId("vanilla")], fallback: "", only: [yui.SCREEN], description: "The look of the screen's elements where they don't set it themselves: none is yog-ui's plain look, minecraft:vanilla the game's windows, buttons and slots." },
  { attr: yuiAttr.ANCHOR, name: "Anchor", category: "Screen", kind: "enum", options: ANCHORS, fallback: screenAnchor.CENTER, only: [yui.SCREEN], description: "Where the screen sits in the game window; fill stretches it over the whole window." },
  { attr: yuiAttr.MODAL, name: "Modal", category: "Screen", kind: "bool", fallback: "true", only: [yui.SCREEN], description: "Whether the screen takes the mouse and keyboard while open (open_ui's modal)." },
  { attr: yuiAttr.PAUSE, name: "Pauses Game", category: "Screen", kind: "bool", fallback: "false", only: [yui.SCREEN], description: "Whether single-player pauses while the screen is open." },
  { attr: yuiAttr.X, name: "X", category: "Layout", kind: "number", not: [yui.SCREEN], description: "Left edge, in GUI pixels from the container's content box. Children of a Canvas are always placed at x/y; in a Row or Column, setting x/y takes a child out of the flow." },
  { attr: yuiAttr.Y, name: "Y", category: "Layout", kind: "number", not: [yui.SCREEN], description: "Top edge, in GUI pixels from the container's content box." },
  { attr: yuiAttr.W, name: "Width", category: "Layout", kind: "units", fallback: "auto", not: [yui.SCREEN], description: "Width: pixels (`80`), a percentage of the container (`50%`), or `auto` to size to the content." },
  { attr: yuiAttr.H, name: "Height", category: "Layout", kind: "units", fallback: "auto", not: [yui.SCREEN], description: "Height: pixels, a percentage of the container, or `auto`." },
  { attr: yuiAttr.MIN_W, name: "Minimum Width", category: "Layout", kind: "number", fallback: "4", description: "The smallest width the widget is laid out at." },
  { attr: yuiAttr.MIN_H, name: "Minimum Height", category: "Layout", kind: "number", fallback: "4", description: "The smallest height the widget is laid out at." },
  { attr: yuiAttr.FLEX, name: "Flex", category: "Layout", kind: "number", fallback: "0", not: [yui.SCREEN], description: "Share of the free space along a Row's or Column's direction (0 = none)." },
  { attr: yuiAttr.TOOLTIP, name: "Tooltip", category: "Common", kind: "text", not: [yui.SCREEN], description: "Text shown next to the cursor while it rests on the widget (\\n breaks lines)." },
  { attr: yuiAttr.DOCK, name: "Dock", category: "Layout", kind: "enum", options: ["none", "fill", "left", "right", "top", "bottom"], fallback: "none", not: [yui.SCREEN], description: "Docks the widget to an edge of its Row/Column, or makes it fill the space left." },
  { attr: yuiAttr.GAP, name: "Gap", category: "Layout", kind: "number", fallback: "2", only: [...CONTAINER_KINDS].filter((k) => k !== yui.GRID), description: "Space between flowing children." },
  { attr: yuiAttr.MARGIN, name: "Margin", category: "Layout", kind: "padding", fallback: "0", not: [yui.SCREEN], description: "Space outside the widget: one value for all sides, `vertical horizontal`, or `top right bottom left` (WPF's Margin)." },
  { attr: yuiAttr.HALIGN, name: "Horizontal Alignment", category: "Layout", kind: "enum", options: ["left", "center", "right", "stretch"], not: [yui.SCREEN], description: "Where the widget sits across the width it's given (WPF's HorizontalAlignment). In a Grid cell the default is stretch (an explicit w is centred); in a Column it overrides the Column's align for this child." },
  { attr: yuiAttr.VALIGN, name: "Vertical Alignment", category: "Layout", kind: "enum", options: ["top", "center", "bottom", "stretch"], not: [yui.SCREEN], description: "Where the widget sits across the height it's given (WPF's VerticalAlignment). In a Grid cell the default is stretch (an explicit h is centred); in a Row it overrides the Row's align for this child." },
  { attr: yuiAttr.ROWS, name: "Rows", category: "Grid", kind: "tracks", axis: "rows", fallback: "*", only: [yui.GRID], description: "The grid's row heights, comma-separated: Auto fits the content, * shares the height left (2* gets twice as much), a number is pixels — `Auto,*,26`. … edits them with minimum and maximum heights (written as <Grid.RowDefinitions>)." },
  { attr: yuiAttr.COLUMNS, name: "Columns", category: "Grid", kind: "tracks", axis: "cols", fallback: "*", only: [yui.GRID], description: "The grid's column widths, comma-separated: Auto, * / 2* or pixels — `160,*`. … edits them with minimum and maximum widths (written as <Grid.ColumnDefinitions>)." },
  { attr: yuiAttr.ROW_SPACING, name: "Row Spacing", category: "Grid", kind: "number", fallback: "0", only: [yui.GRID], description: "Space between rows, in GUI pixels (WinUI's RowSpacing)." },
  { attr: yuiAttr.COLUMN_SPACING, name: "Column Spacing", category: "Grid", kind: "number", fallback: "0", only: [yui.GRID], description: "Space between columns, in GUI pixels (WinUI's ColumnSpacing)." },
  { attr: yuiAttr.GRID_ROW, name: "Row", category: "Grid", kind: "index", fallback: "0", attached: true, not: [yui.SCREEN], description: "The grid row the widget is in, from 0 (Grid.Row)." },
  { attr: yuiAttr.GRID_COLUMN, name: "Column", category: "Grid", kind: "index", fallback: "0", attached: true, not: [yui.SCREEN], description: "The grid column the widget is in, from 0 (Grid.Column)." },
  { attr: yuiAttr.GRID_ROWSPAN, name: "Row Span", category: "Grid", kind: "span", fallback: "1", attached: true, not: [yui.SCREEN], description: "How many rows the widget spans (Grid.RowSpan)." },
  { attr: yuiAttr.GRID_COLUMNSPAN, name: "Column Span", category: "Grid", kind: "span", fallback: "1", attached: true, not: [yui.SCREEN], description: "How many columns the widget spans (Grid.ColumnSpan)." },
  { attr: yuiAttr.PADDING, name: "Padding", category: "Layout", kind: "padding", fallback: "0", description: "Inner spacing: one value for all sides, `vertical horizontal`, or `top right bottom left`." },
  { attr: yuiAttr.ALIGN, name: "Alignment", category: "Layout", kind: "enum", options: ["start", "center", "end"], fallback: "start", description: "Cross-axis alignment of a container's children; horizontal alignment of a Label's text." },
  { attr: yuiAttr.TEXT, name: "Text", category: "Appearance", kind: "text", only: TEXT_KINDS, description: "The text shown (a text box's initial text)." },
  { attr: yuiAttr.PLACEHOLDER, name: "Placeholder", category: "Appearance", kind: "text", only: [yui.TEXT_BOX], description: "Greyed hint shown while the text box is empty." },
  { attr: yuiAttr.BG, name: "Background", category: "Appearance", kind: "color", description: "Background color — `#RRGGBB` or `#AARRGGBB`. Empty draws none." },
  { attr: yuiAttr.COLOR, name: "Text Color", category: "Appearance", kind: "color", fallback: "#FFCCCCAA", only: TEXT_KINDS, description: "Text color — `#RRGGBB` or `#AARRGGBB`." },
  { attr: yuiAttr.FONT, name: "Font", category: "Appearance", kind: "text", fallback: yog.DEFAULT_FONT, only: TEXT_KINDS, suggestions: GAME_FONTS, description: "The font: one of the mod's (mymod:font/fancy), or a game font by Yog's alias — yog:font/default, yog:font/uniform (Unifont), yog:font/alt (enchanting table), yog:font/illageralt." },
  { attr: yuiAttr.FONT_SCALE, name: "Font Scale", category: "Appearance", kind: "number", fallback: "1", only: TEXT_KINDS, description: "Text size multiplier." },
  { attr: yuiAttr.SHADOW, name: "Text Shadow", category: "Appearance", kind: "bool", fallback: "true", only: TEXT_KINDS, description: "Draws the text with Minecraft's drop shadow." },
  { attr: yuiAttr.NO_WRAP, name: "No Wrap", category: "Appearance", kind: "bool", fallback: "false", only: WRAP_KINDS, description: "Keeps the text on one line instead of wrapping it to the width." },
  { attr: yuiAttr.ELLIPSIS, name: "Ellipsis", category: "Appearance", kind: "bool", fallback: "false", only: WRAP_KINDS, description: "One line, cut with `...` when it's wider than the widget." },
  { attr: yuiAttr.FOCUS_STYLE, name: "Focus Style", category: "Appearance", kind: "enum", options: ["outline", "fill", "none"], fallback: "outline", description: "How keyboard focus is shown." },
  { attr: yuiAttr.FOCUS_COLOR, name: "Focus Color", category: "Appearance", kind: "color", description: "Color of the focus indicator (default amber)." },
  { attr: yuiAttr.ENABLED, name: "Enabled", category: "Behavior", kind: "bool", fallback: "true", description: "Whether the widget takes clicks and focus." },
  { attr: yuiAttr.ON_CLICK, name: "On Click", category: "Events", kind: "text", not: [yui.SCREEN], description: "The event raised when it's clicked — a constant in the generated `events` module; `click()` returns it." },
  { attr: yuiAttr.MAX_LENGTH, name: "Max Length", category: "Behavior", kind: "number", fallback: "0", only: [yui.TEXT_BOX], description: "The most characters the text box takes (0 = no limit)." },
  { attr: yuiAttr.ON_CHANGE, name: "On Change", category: "Events", kind: "text", only: [yui.TEXT_BOX], description: "The event raised when the text box's text changes — a constant in the generated `events` module; `TextBoxState::event_name` returns it." },
  { attr: yuiAttr.ON_SUBMIT, name: "On Submit", category: "Events", kind: "text", only: [yui.TEXT_BOX], description: "The event raised when Enter is pressed in the text box — a constant in the generated `events` module." },
  { attr: yuiAttr.ITEM, name: "Item", category: "Data", kind: "text", only: [yui.ITEM_SLOT, yui.INV_SLOT], description: "The item shown, as `namespace:id`." },
  { attr: yuiAttr.SLOT, name: "Recipe Slot", category: "Data", kind: "text", only: [yui.RECIPE_SLOT], description: "Which slot of the recipe's kind this place is for — a mod kind's slot (its .ydef), or the game's: grid, input, template, base, addition." },
  { attr: yuiAttr.INDEX, name: "Place", category: "Data", kind: "number", fallback: "0", only: [yui.RECIPE_SLOT], description: "Which of the slot's ingredients goes here: 0, 1, … (empty: the next after this slot's last place)." },
  { attr: yuiAttr.FRAME, name: "Frame", category: "Appearance", kind: "bool", fallback: "false", only: [yui.RECIPE_SLOT, yui.RECIPE_RESULT], description: "A slot frame behind it, for layouts without their own picture." },
  { attr: `${yuiMarkup.DESIGN}${yuiAttr.ITEM}`, name: "Sample Item", category: "Design", kind: "text", only: [yui.RECIPE_SLOT, yui.RECIPE_RESULT], description: "An item shown here in the designer only — what a recipe might put in it." },
  { attr: yuiAttr.KIND, name: "Recipe Kind", category: "Data", kind: "text", only: [yui.RECIPE_AREA], description: "The kind of recipe it makes — the mod's (assembly, its namespace added; a .ydef recipe_kind) or another's (mymod:infusion). Its layout is the .yui <Component recipe_layout> for that kind." },
  { attr: yuiAttr.INDEX, name: "Slot Index", category: "Data", kind: "number", fallback: "0", only: [yui.SLOT], description: "Which slot of the block's inventory this is (0, 1, …)." },
  { attr: yuiAttr.COUNT, name: "Count", category: "Data", kind: "number", fallback: "1", only: [yui.INV_SLOT], description: "The stack size drawn in the corner (shown when over 1)." },
  { attr: yuiAttr.SOURCE, name: "Source", category: "Data", kind: "image", only: [yui.IMAGE], description: "What the image shows — a Yog image source, the same on every Minecraft version and loader: item:apple, block:stone, sprite:button (Yog's GUI sprite names), mod:gui/logo (this mod's assets/<mod id>/textures/gui/logo.png) or othermod:gui/logo." },
  { attr: yuiAttr.STRETCH, name: "Stretch", category: "Data", kind: "enum", options: ["None", "Fill", "Uniform", "UniformToFill"], fallback: "Uniform", only: [yui.IMAGE], description: "How the image fills the widget: None = natural size, centered; Fill = the whole box; Uniform = as large as fits, aspect kept; UniformToFill = covers the box, aspect kept, the overflow cut (textures only)." },
  { attr: yuiAttr.UV, name: "Region", category: "Data", kind: "uv", only: [yui.IMAGE], description: "Part of a texture to show, `u v w h` in the image's pixels (textures only). Empty = the whole image." },
  { attr: yuiAttr.TINT, name: "Tint", category: "Appearance", kind: "color", fallback: "#FFFFFFFF", only: [yui.IMAGE], description: "Multiplies the image's colors — `#RRGGBB` or `#AARRGGBB` (items aren't tinted)." },
];

const applies = (spec: AttrSpec, kind: string) => (!spec.only || spec.only.includes(kind)) && !spec.not?.includes(kind);

// ── Components (docs/yui.md, "Components") ──────────────────────────────────

/** A `<Property type>`'s types — `event` is an `<Event>`. */
const PROP_TYPES = ["text", "number", "int", "bool", "color", "choice", "image"] as const;

/** The `<Component>` root of a component's own `.yui` — its designer metadata. */
const COMPONENT_SPECS: AttrSpec[] = [
  { attr: yuiAttr.NAME, name: "Name", category: "Component", kind: "text", description: "The component's name (PascalCase) — its element in other .yui files (<StatBar .../>) and its Rust type." },
  { attr: yuiComponent.DISPLAY_NAME, name: "Display Name", category: "Toolbox", kind: "text", description: "The Toolbox's label for it (default: Name). @res:Strings.key for a translated text." },
  { attr: yuiComponent.DESCRIPTION, name: "Description", category: "Toolbox", kind: "text", description: "What it is — the Toolbox's tooltip and the Properties description of its instances. @res:Strings.key for a translated text." },
  { attr: yuiComponent.ICON, name: "Icon", category: "Toolbox", kind: "image", description: "The Toolbox's icon: a Yog image source (item:apple, sprite:button, mod:gui/logo) or @res:Icons.name." },
  { attr: yuiComponent.CATEGORY, name: "Category", category: "Toolbox", kind: "text", description: "The Toolbox category it's listed in (default: \"<mod> Components\"). @res:Strings.key for a translated text." },
  { attr: yuiComponent.TOOLBOX, name: "Show in Toolbox", category: "Toolbox", kind: "bool", fallback: "true", description: "Whether the Toolbox offers it — false for parts used only inside the mod's other components." },
  { attr: yuiComponent.DESIGN_W, name: "Design Width", category: "Design", kind: "number", fallback: "120", description: "The canvas width for editing it, and an instance's width when dropped from the Toolbox." },
  { attr: yuiComponent.DESIGN_H, name: "Design Height", category: "Design", kind: "number", fallback: "40", description: "The canvas height for editing it, and an instance's height when dropped from the Toolbox." },
  { attr: `${yuiMarkup.DESIGN}${yuiAttr.BG}`, name: "Design Background", category: "Design", kind: "color", description: "A background drawn only in the designer, behind the component." },
];

/** A `<Property>` declaration. */
const PROPERTY_SPECS: AttrSpec[] = [
  { attr: yuiAttr.NAME, name: "Name", category: "Property", kind: "text", description: "The property's name — its attribute on instances and its field in the generated type; bind to it in the body with {x:Bind name}." },
  { attr: yuiAttr.TYPE, name: "Type", category: "Property", kind: "enum", options: PROP_TYPES, fallback: "text", description: "What it holds: text, number, int, bool, color, choice (one of Options) or image (an image source)." },
  { attr: yuiAttr.DEFAULT, name: "Default", category: "Property", kind: "text", description: "Its value when an instance doesn't set it — also what the designer shows here." },
  { attr: yuiComponent.OPTIONS, name: "Options", category: "Property", kind: "text", description: "A choice property's values, comma-separated." },
  { attr: yuiComponent.DOC, name: "Description", category: "Property", kind: "text", description: "Shown in Properties for instances and as the field's doc comment." },
  { attr: yuiComponent.CATEGORY, name: "Category", category: "Property", kind: "text", description: "The Properties category instances show it in (default: the component's name)." },
];

/** An `<Event>` declaration. */
const EVENT_SPECS: AttrSpec[] = [
  { attr: yuiAttr.NAME, name: "Name", category: "Event", kind: "text", description: "The event's name (on_select) — instances name the event raised; bind a button's on_click to it with {x:Bind on_select}." },
  { attr: yuiComponent.DOC, name: "Description", category: "Event", kind: "text", description: "Shown in Properties for instances." },
  { attr: yuiComponent.CATEGORY, name: "Category", category: "Event", kind: "text", description: "The Properties category instances show it in (default: Events)." },
];

/** An instance's rows for the component's declared properties, in their categories (default: the component's name / Events). */
function instanceSpecs(info: ComponentInfo): AttrSpec[] {
  return info.props.map((p) => ({
    attr: p.name,
    name: p.name,
    category: p.category ? designText(p.category) : p.kind === "event" ? t("Events") : designText(info.display_name || info.name),
    raw: true,
    kind: p.kind === "bool" ? "bool" : p.kind === "choice" ? "enum" : p.kind === "number" || p.kind === "int" ? "number" : p.kind === "color" ? "color" : p.kind === "image" ? "image" : "text",
    options: p.kind === "choice" ? p.options : undefined,
    fallback: p.kind === "event" || p.default === "" ? undefined : p.default,
    description: p.doc ? designText(p.doc) : `${info.name}.${p.name}`,
  }));
}

/** The rows a `kind` has: a built-in widget's, a component instance's, or a component document's own. */
function specsFor(kind: string, components: ComponentsSnapshot | null): AttrSpec[] {
  if (kind === yui.COMPONENT) return COMPONENT_SPECS;
  if (kind === yui.PROPERTY) return PROPERTY_SPECS;
  if (kind === yui.EVENT) return EVENT_SPECS;
  const info = KIND_INFO[kind as keyof typeof KIND_INFO] ? null : findComponent(components, kind);
  // An instance's own attributes (x, w, bg, ...) override its body's root; its events are its declared ones.
  if (info) return [...instanceSpecs(info), ...SPECS.filter((spec) => spec.category !== "Events" && applies(spec, kind))];
  return SPECS.filter((spec) => applies(spec, kind));
}

/** Rejects a value the generator wouldn't accept (`yog ui gen` checks the same). */
function check(kind: AttrKind, value: string, attr = ""): string | null {
  const v = value.trim();
  if (v === "" || /^\{x:Bind[\s}]/.test(v)) return null;
  // A resource (`@res:Colors.accent`), and a background image (`sprite:panel`).
  if (kind === "color" && /^@[A-Za-z_][\w.]*$/.test(v)) return null;
  if (kind === "color" && /(^|:)bg$/.test(attr) && /^[a-z0-9_.-]+:\S+$/.test(v)) return null;
  if (attr === yuiAttr.FONT) return gameFontNamedDirectly(v);
  switch (kind) {
    case "number":
      return parseNumber(v) === null ? t("Expected a number.") : null;
    case "tracks": {
      const bad = v.split(",").find((p) => !parseLength(p));
      return bad === undefined ? null : t("`{value}` isn't a size — expected Auto, *, 2* or pixels (26).", { value: bad.trim() });
    }
    case "index":
      return /^\d+$/.test(v) ? null : t("Expected a whole number (0 = the first).");
    case "span":
      return /^\d+$/.test(v) && Number(v) >= 1 ? null : t("Expected a whole number, at least 1.");
    case "units":
      return v === "auto" || parseNumber(v.endsWith("%") ? v.slice(0, -1) : v) !== null ? null : t("Expected pixels (80), a percentage (50%) or auto.");
    case "color":
      return parseColor(v) === null ? t("Expected a color like #RRGGBB or #AARRGGBB.") : null;
    case "uv": {
      const parts = v.split(/[\s,]+/);
      return parts.length === 4 && parts.every((p) => parseNumber(p) !== null) ? null : t("Expected 4 numbers: u v w h.");
    }
    case "image":
      return /^[a-z0-9_.-]+:\S+$/.test(v) ? null : t("Expected an image source such as item:apple, sprite:button or mod:gui/logo.");
    case "padding": {
      const parts = v.split(/[\s,]+/);
      return [1, 2, 4].includes(parts.length) && parts.every((p) => parseNumber(p) !== null) ? null : t("Expected 1, 2 or 4 numbers.");
    }
    default:
      return null;
  }
}

/** Events in Properties, as Visual Studio's Events tab: naming one opens its handler. */
export interface EventActions {
  /** A fresh event name for `attr` on `node` (`<id>_click`). */
  suggest: (node: YuiNode, attr: string) => string;
  /** Opens the handler of `node`'s `attr` event in the code-behind (adding it if missing). */
  open: (node: YuiNode, attr: string) => void;
}

/**
 * The rows for `nodes` (the designer's selection; several = only what they
 * all have, a value shown only where they agree). `apply` sets an attribute
 * on all of them (`undefined` removes it) and returns an error, if any.
 */
export function widgetProperties(
  nodes: YuiNode[],
  apply: (attr: string, value: string | undefined) => string | null,
  events?: EventActions,
  yuiPath?: string,
  components: ComponentsSnapshot | null = null,
  grid?: GridContext,
): PropertyDescriptor[] {
  if (nodes.length === 0) return [];
  const rows: PropertyDescriptor[] = [];
  const lists = nodes.map((n) => specsFor(n.kind, components).filter((spec) => !spec.attached || grid?.inGrid));
  const specs = lists[0].filter((spec) => lists.every((l) => l.some((o) => o.attr === spec.attr && o.kind === spec.kind)));
  for (const spec of specs) {
    if ((spec.attr === "id" || spec.attr === "name") && nodes.length > 1) continue;
    if (spec.axis) {
      if (grid) rows.push(tracksRow(spec, spec.axis, nodes, grid));
      continue;
    }
    const values = nodes.map((n) => n.attrs[spec.attr]);
    const same = values.every((v) => v === values[0]);
    const raw = same ? values[0] : undefined;
    const shown = raw ?? (same ? (spec.fallback ?? "") : "");
    const row: PropertyDescriptor = {
      id: spec.attr,
      name: spec.raw ? spec.name : pt("property", spec.name),
      category: spec.raw ? spec.category : t(spec.category),
      description: spec.raw ? spec.description : t(spec.description),
      value: shown,
      onCommit: (value: PropertyValue) => {
        const text = String(value).trim();
        // Choosing the default removes the attribute — the file stays minimal.
        const error = apply(spec.attr, text === "" || text === spec.fallback ? undefined : text);
        // Naming an event (as in Visual Studio's Events tab) takes you to its handler.
        if (!error && text !== "" && spec.category === "Events" && SPECS.includes(spec) && events && nodes.length === 1) events.open(nodes[0], spec.attr);
        return error;
      },
    };
    if (spec.kind === "bool") {
      row.kind = "bool";
      row.value = same ? shown === "true" : null;
    } else if (spec.kind === "enum") {
      row.kind = "enum";
      row.options = spec.options;
    } else {
      row.kind = "string";
      row.suggestions = spec.category === "Events" && SPECS.includes(spec) && events && nodes.length === 1 && !raw ? [events.suggest(nodes[0], spec.attr)] : spec.suggestions;
      row.validate = (value) => check(spec.kind, String(value), spec.attr);
      if (spec.kind === "image") {
        if (yuiPath) {
          row.suggestions = imageSources(yuiPath).map((c) => c.source);
          if (shown) row.image = imagePreview(yuiPath, shown) ?? undefined;
        }
        const alias = yuiPath ? imageAlias(yuiPath, shown) : null;
        if (alias) row.description = `${row.description}\n\n${t("This is a raw resource path; use {alias} instead.", { alias })}`;
      }
      if (spec.attr === yuiAttr.FONT && yuiPath && same) offerFontCopy(row, yuiPath, shown, (id) => apply(spec.attr, id));
      if (spec.kind === "color") {
        const color = parseColor(designColor(shown));
        if (color !== null) row.swatch = cssColor(color);
        row.suggestions = colorRefs();
        // A literal color → a new entry of resources/Colors.yres, referenced instead.
        const root = yuiPath ? modRootOf(yuiPath) : null;
        if (root && parseColor(shown) !== null && !shown.startsWith("@") && raw !== undefined) {
          const hint = `${nodes[0].attrs.id ?? nodes[0].kind}_${spec.attr.replace(":", "_")}`;
          row.edit = () => void extractColor(root, hint, shown).then((ref) => apply(spec.attr, ref));
          row.description = `${row.description}\n\n${t("… moves the color into resources/Colors.yres and refers to it.")}`;
        }
      }
    }
    if (same && raw === undefined && spec.fallback !== undefined && spec.kind !== "bool") row.displayValue = `${spec.fallback} ${t("(default)")}`;
    rows.push(row);
  }
  return rows;
}

/** What Properties needs to edit grids: whether the selection is in one, and a way to rewrite the selected nodes. */
export interface GridContext {
  /** Every selected widget is a Grid's child (its Row / Column rows show). */
  inGrid: boolean;
  /** Replaces each selected node with `fn(node)` (one undo step). */
  update: (fn: (node: YuiNode) => YuiNode) => string | null;
}

/** A grid's Rows / Columns row: shown and edited compactly, kept in whichever form the file uses; "…" opens the collection editor. */
function tracksRow(spec: AttrSpec, axis: Axis, nodes: YuiNode[], grid: GridContext): PropertyDescriptor {
  const shown = nodes.map((n) => gridDefs(n)[axis].map((d) => formatLength(d.size)).join(","));
  const same = shown.every((v) => v === shown[0]);
  const limited = nodes.some((n) => gridDefs(n)[axis].some((d) => d.min !== null || d.max !== null));
  const row: PropertyDescriptor = {
    id: spec.attr,
    name: pt("property", spec.name),
    category: t(spec.category),
    description: t(spec.description),
    kind: "string",
    value: same ? shown[0] : "",
    suggestions: ["Auto,*", "*,*", "Auto,*,Auto", "*,2*"],
    validate: (value) => check("tracks", String(value)),
    onCommit: (value) => {
      const text = String(value).trim();
      return grid.update((n) => {
        const old = gridDefs(n)[axis];
        // Sizes from the text, each row's limits kept.
        const defs = text === "" ? [] : text.split(",").map((p, i) => ({ size: parseLength(p) ?? { t: "star" as const, v: 1 }, min: old[i]?.min ?? null, max: old[i]?.max ?? null }));
        return shiftCells(withGridDefs(n, axis, defs), axis, 0, 0, Math.max(1, defs.length));
      });
    },
    edit:
      nodes.length === 1
        ? () =>
            void editDefinitions(nodes[0], axis).then((next) => {
              if (next) grid.update(() => next);
            })
        : undefined,
  };
  if (same && shown[0] === "") row.displayValue = `* ${t("(default)")}`;
  else if (limited) row.displayValue = `${same ? shown[0] : ""} ${t("(with limits)")}`;
  return row;
}

/**
 * The `.yui` vocabulary for the XAML editor's completion — every element
 * with the attributes Properties offers for it, enum and boolean values
 * included, descriptions as completion info (in the current language).
 */
export function yuiSchema(): XmlSchema {
  const children = KINDS.filter((k) => k !== yui.SCREEN);
  const attributes = (specs: AttrSpec[]) =>
    specs.map((spec) => ({
      name: spec.attr,
      values: spec.kind === "bool" ? ["true", "false"] : spec.kind === "enum" ? spec.options : spec.suggestions,
      completion: { info: t(spec.description), detail: spec.fallback !== undefined ? `= ${spec.fallback}` : undefined },
    }));
  // A component's own .yui (docs/yui.md, "Components").
  const component = [
    {
      name: "Component",
      top: true,
      children: ["Property", "Event", ...children],
      completion: { info: t("A reusable component: its properties and events, then one body element bound to them with {x:Bind name}.") },
      attributes: attributes(COMPONENT_SPECS),
    },
    { name: "Property", top: false, children: [], completion: { info: t("A property of the component — an attribute of its instances.") }, attributes: attributes(PROPERTY_SPECS) },
    { name: "Event", top: false, children: [], completion: { info: t("An event the component raises — instances name it.") }, attributes: attributes(EVENT_SPECS) },
  ];
  // A Grid's definitions, in WPF's property-element form (docs/yui.md, "Grid").
  const definitions = (["rows", "cols"] as const).flatMap((axis) => {
    const a = AXES[axis];
    const row = axis === "rows";
    return [
      {
        name: a.prop,
        top: false,
        children: [a.def],
        completion: { info: row ? t("The grid's rows, one <RowDefinition> each (instead of rows=\"...\").") : t("The grid's columns, one <ColumnDefinition> each (instead of columns=\"...\").") },
        attributes: [],
      },
      {
        name: a.def,
        top: false,
        children: [],
        completion: { info: row ? t("One grid row: its height and limits.") : t("One grid column: its width and limits.") },
        attributes: [
          { name: a.size, values: ["Auto", "*", "2*"], completion: { info: t("Auto fits the content, * shares what's left (2* gets twice as much), a number is pixels."), detail: "= *" } },
          { name: a.min, values: undefined, completion: { info: row ? t("The smallest height the row gets, in pixels.") : t("The smallest width the column gets, in pixels.") } },
          { name: a.max, values: undefined, completion: { info: row ? t("The largest height the row gets, in pixels.") : t("The largest width the column gets, in pixels.") } },
        ],
      },
    ];
  });
  return {
    elements: [...component, ...definitions, ...KINDS.map((kind) => ({
      name: kind,
      top: kind === yui.SCREEN,
      children: kind === yui.GRID ? [AXES.rows.prop, AXES.cols.prop, ...children] : CONTAINER_KINDS.has(kind) ? children : [],
      completion: { info: t(KIND_INFO[kind].description) },
      attributes: SPECS.filter((spec) => applies(spec, kind)).map((spec) => ({
        name: spec.attr,
        values: spec.kind === "bool" ? ["true", "false"] : spec.kind === "enum" ? spec.options : spec.kind === "units" ? ["auto"] : spec.kind === "tracks" ? ["Auto,*", "*,*", "Auto,*,Auto"] : spec.suggestions,
        completion: { info: t(spec.description), detail: spec.fallback !== undefined ? `= ${spec.fallback}` : undefined },
      })),
    }))],
  };
}
