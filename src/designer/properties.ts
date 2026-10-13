// What the Properties window shows for the widgets selected in the screen
// designer — one row per `.yui` attribute the selection can have.

import { t, type PropertyDescriptor, type PropertyValue, type XmlSchema } from "substrate-platform-ui";
import { imagePreview, imageSources, suggestImageAlias } from "./imageSources";
import { CONTAINER_KINDS, cssColor, KIND_INFO, KINDS, parseColor, parseNumber, type YuiNode } from "./yui";
import { findComponent, type ComponentInfo, type ComponentsSnapshot } from "./components";

type AttrKind = "text" | "number" | "units" | "color" | "bool" | "enum" | "padding" | "uv" | "image";

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
}

const TEXT_KINDS = ["Label", "Button", "TextBox"];
/** Text that wraps (a text box scrolls its one line instead). */
const WRAP_KINDS = ["Label", "Button"];
/** Vanilla's fonts; a resource pack can add more (`namespace:name`). */
const FONTS = ["minecraft:default", "minecraft:uniform", "minecraft:alt", "minecraft:illageralt"] as const;
const ANCHORS = ["center", "top_left", "top", "top_right", "left", "right", "bottom_left", "bottom", "bottom_right", "fill"] as const;

const SPECS: AttrSpec[] = [
  { attr: "id", name: "(Name)", category: "Design", kind: "text", description: "The widget's id — a constant in the generated `ids` module, and what `find_mut` looks it up by. The screen's own id is its UI id, `<modid>:<name>`." },
  { attr: "width", name: "Width", category: "Screen", kind: "number", fallback: "176", only: ["Screen"], description: "The screen's width in GUI pixels." },
  { attr: "height", name: "Height", category: "Screen", kind: "number", fallback: "166", only: ["Screen"], description: "The screen's height in GUI pixels." },
  { attr: "anchor", name: "Anchor", category: "Screen", kind: "enum", options: ANCHORS, fallback: "center", only: ["Screen"], description: "Where the screen sits in the game window; fill stretches it over the whole window." },
  { attr: "modal", name: "Modal", category: "Screen", kind: "bool", fallback: "true", only: ["Screen"], description: "Whether the screen takes the mouse and keyboard while open (open_ui's modal)." },
  { attr: "pause", name: "Pauses Game", category: "Screen", kind: "bool", fallback: "false", only: ["Screen"], description: "Whether single-player pauses while the screen is open." },
  { attr: "x", name: "X", category: "Layout", kind: "number", not: ["Screen"], description: "Left edge, in GUI pixels from the container's content box. Children of a Canvas are always placed at x/y; in a Row or Column, setting x/y takes a child out of the flow." },
  { attr: "y", name: "Y", category: "Layout", kind: "number", not: ["Screen"], description: "Top edge, in GUI pixels from the container's content box." },
  { attr: "w", name: "Width", category: "Layout", kind: "units", fallback: "auto", not: ["Screen"], description: "Width: pixels (`80`), a percentage of the container (`50%`), or `auto` to size to the content." },
  { attr: "h", name: "Height", category: "Layout", kind: "units", fallback: "auto", not: ["Screen"], description: "Height: pixels, a percentage of the container, or `auto`." },
  { attr: "min_w", name: "Minimum Width", category: "Layout", kind: "number", fallback: "4", description: "The smallest width the widget is laid out at." },
  { attr: "min_h", name: "Minimum Height", category: "Layout", kind: "number", fallback: "4", description: "The smallest height the widget is laid out at." },
  { attr: "flex", name: "Flex", category: "Layout", kind: "number", fallback: "0", not: ["Screen"], description: "Share of the free space along a Row's or Column's direction (0 = none)." },
  { attr: "dock", name: "Dock", category: "Layout", kind: "enum", options: ["none", "fill", "left", "right", "top", "bottom"], fallback: "none", not: ["Screen"], description: "Docks the widget to an edge of its Row/Column, or makes it fill the space left." },
  { attr: "gap", name: "Gap", category: "Layout", kind: "number", fallback: "2", only: [...CONTAINER_KINDS], description: "Space between flowing children." },
  { attr: "padding", name: "Padding", category: "Layout", kind: "padding", fallback: "0", description: "Inner spacing: one value for all sides, `vertical horizontal`, or `top right bottom left`." },
  { attr: "align", name: "Alignment", category: "Layout", kind: "enum", options: ["start", "center", "end"], fallback: "start", description: "Cross-axis alignment of a container's children; horizontal alignment of a Label's text." },
  { attr: "text", name: "Text", category: "Appearance", kind: "text", only: TEXT_KINDS, description: "The text shown (a text box's initial text)." },
  { attr: "placeholder", name: "Placeholder", category: "Appearance", kind: "text", only: ["TextBox"], description: "Greyed hint shown while the text box is empty." },
  { attr: "bg", name: "Background", category: "Appearance", kind: "color", description: "Background color — `#RRGGBB` or `#AARRGGBB`. Empty draws none." },
  { attr: "color", name: "Text Color", category: "Appearance", kind: "color", fallback: "#FFCCCCAA", only: TEXT_KINDS, description: "Text color — `#RRGGBB` or `#AARRGGBB`." },
  { attr: "font", name: "Font", category: "Appearance", kind: "text", fallback: "minecraft:default", only: TEXT_KINDS, suggestions: FONTS, description: "The font, as a font id: minecraft:default, minecraft:uniform (Unifont), minecraft:alt (enchanting table), minecraft:illageralt, or one from a resource pack." },
  { attr: "font_scale", name: "Font Scale", category: "Appearance", kind: "number", fallback: "1", only: TEXT_KINDS, description: "Text size multiplier." },
  { attr: "shadow", name: "Text Shadow", category: "Appearance", kind: "bool", fallback: "true", only: TEXT_KINDS, description: "Draws the text with Minecraft's drop shadow." },
  { attr: "no_wrap", name: "No Wrap", category: "Appearance", kind: "bool", fallback: "false", only: WRAP_KINDS, description: "Keeps the text on one line instead of wrapping it to the width." },
  { attr: "ellipsis", name: "Ellipsis", category: "Appearance", kind: "bool", fallback: "false", only: WRAP_KINDS, description: "One line, cut with `...` when it's wider than the widget." },
  { attr: "focus_style", name: "Focus Style", category: "Appearance", kind: "enum", options: ["outline", "fill", "none"], fallback: "outline", description: "How keyboard focus is shown." },
  { attr: "focus_color", name: "Focus Color", category: "Appearance", kind: "color", description: "Color of the focus indicator (default amber)." },
  { attr: "enabled", name: "Enabled", category: "Behavior", kind: "bool", fallback: "true", description: "Whether the widget takes clicks and focus." },
  { attr: "on_click", name: "On Click", category: "Events", kind: "text", not: ["Screen"], description: "The event raised when it's clicked — a constant in the generated `events` module; `click()` returns it." },
  { attr: "max_length", name: "Max Length", category: "Behavior", kind: "number", fallback: "0", only: ["TextBox"], description: "The most characters the text box takes (0 = no limit)." },
  { attr: "on_change", name: "On Change", category: "Events", kind: "text", only: ["TextBox"], description: "The event raised when the text box's text changes — a constant in the generated `events` module; `TextBoxState::event_name` returns it." },
  { attr: "on_submit", name: "On Submit", category: "Events", kind: "text", only: ["TextBox"], description: "The event raised when Enter is pressed in the text box — a constant in the generated `events` module." },
  { attr: "item", name: "Item", category: "Data", kind: "text", only: ["ItemSlot", "InvSlot"], description: "The item shown, as `namespace:id`." },
  { attr: "count", name: "Count", category: "Data", kind: "number", fallback: "1", only: ["InvSlot"], description: "The stack size drawn in the corner (shown when over 1)." },
  { attr: "source", name: "Source", category: "Data", kind: "image", only: ["Image"], description: "What the image shows — a Yog image source, the same on every Minecraft version and loader: item:apple, block:stone, sprite:button (Yog's GUI sprite names), mod:gui/logo (this mod's assets/<mod id>/textures/gui/logo.png) or othermod:gui/logo." },
  { attr: "stretch", name: "Stretch", category: "Data", kind: "enum", options: ["None", "Fill", "Uniform", "UniformToFill"], fallback: "Uniform", only: ["Image"], description: "How the image fills the widget: None = natural size, centered; Fill = the whole box; Uniform = as large as fits, aspect kept; UniformToFill = covers the box, aspect kept, the overflow cut (textures only)." },
  { attr: "uv", name: "Region", category: "Data", kind: "uv", only: ["Image"], description: "Part of a texture to show, `u v w h` in the image's pixels (textures only). Empty = the whole image." },
  { attr: "tint", name: "Tint", category: "Appearance", kind: "color", fallback: "#FFFFFFFF", only: ["Image"], description: "Multiplies the image's colors — `#RRGGBB` or `#AARRGGBB` (items aren't tinted)." },
];

const applies = (spec: AttrSpec, kind: string) => (!spec.only || spec.only.includes(kind)) && !spec.not?.includes(kind);

// ── Components (docs/yui.md, "Components") ──────────────────────────────────

/** A `<Property type>`'s types — `event` is an `<Event>`. */
const PROP_TYPES = ["text", "number", "int", "bool", "color", "choice", "image"] as const;

/** The `<Component>` root of a component's own `.yui`. */
const COMPONENT_SPECS: AttrSpec[] = [
  { attr: "name", name: "Name", category: "Component", kind: "text", description: "The component's name (PascalCase) — its element in other .yui files (<StatBar .../>) and its Rust type." },
  { attr: "doc", name: "Description", category: "Component", kind: "text", description: "What it is — the Toolbox's tooltip and the generated type's doc comment." },
  { attr: "width", name: "Design Width", category: "Design", kind: "number", fallback: "120", description: "The designer's canvas width for editing it (not its size where it's used — that's its body's w, or the instance's)." },
  { attr: "height", name: "Design Height", category: "Design", kind: "number", fallback: "40", description: "The designer's canvas height for editing it." },
  { attr: "d:bg", name: "Design Background", category: "Design", kind: "color", description: "A background drawn only in the designer, behind the component." },
];

/** A `<Property>` declaration. */
const PROPERTY_SPECS: AttrSpec[] = [
  { attr: "name", name: "Name", category: "Property", kind: "text", description: "The property's name — its attribute on instances and its field in the generated type; bind to it in the body with {x:Bind name}." },
  { attr: "type", name: "Type", category: "Property", kind: "enum", options: PROP_TYPES, fallback: "text", description: "What it holds: text, number, int, bool, color, choice (one of Options) or image (an image source)." },
  { attr: "default", name: "Default", category: "Property", kind: "text", description: "Its value when an instance doesn't set it — also what the designer shows here." },
  { attr: "options", name: "Options", category: "Property", kind: "text", description: "A choice property's values, comma-separated." },
  { attr: "doc", name: "Description", category: "Property", kind: "text", description: "Shown in Properties for instances and as the field's doc comment." },
];

/** An `<Event>` declaration. */
const EVENT_SPECS: AttrSpec[] = [
  { attr: "name", name: "Name", category: "Event", kind: "text", description: "The event's name (on_select) — instances name the event raised; bind a button's on_click to it with {x:Bind on_select}." },
  { attr: "doc", name: "Description", category: "Event", kind: "text", description: "Shown in Properties for instances." },
];

/** An instance's rows for the component's declared properties, in its own category. */
function instanceSpecs(info: ComponentInfo): AttrSpec[] {
  return info.props.map((p) => ({
    attr: p.name,
    name: p.name,
    category: p.kind === "event" ? "Events" : info.name,
    raw: p.kind !== "event",
    kind: p.kind === "bool" ? "bool" : p.kind === "choice" ? "enum" : p.kind === "number" || p.kind === "int" ? "number" : p.kind === "color" ? "color" : p.kind === "image" ? "image" : "text",
    options: p.kind === "choice" ? p.options : undefined,
    fallback: p.kind === "event" || p.default === "" ? undefined : p.default,
    description: p.doc || `${info.name}.${p.name}`,
  }));
}

/** The rows a `kind` has: a built-in widget's, a component instance's, or a component document's own. */
function specsFor(kind: string, components: ComponentsSnapshot | null): AttrSpec[] {
  if (kind === "Component") return COMPONENT_SPECS;
  if (kind === "Property") return PROPERTY_SPECS;
  if (kind === "Event") return EVENT_SPECS;
  const info = KIND_INFO[kind as keyof typeof KIND_INFO] ? null : findComponent(components, kind);
  // An instance's own attributes (x, w, bg, ...) override its body's root; its events are its declared ones.
  if (info) return [...instanceSpecs(info), ...SPECS.filter((spec) => spec.category !== "Events" && applies(spec, kind))];
  return SPECS.filter((spec) => applies(spec, kind));
}

/** Rejects a value the generator wouldn't accept (`yog ui gen` checks the same). */
function check(kind: AttrKind, value: string): string | null {
  const v = value.trim();
  if (v === "" || /^\{x:Bind[\s}]/.test(v)) return null;
  switch (kind) {
    case "number":
      return parseNumber(v) === null ? t("Expected a number.") : null;
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
): PropertyDescriptor[] {
  if (nodes.length === 0) return [];
  const rows: PropertyDescriptor[] = [];
  const lists = nodes.map((n) => specsFor(n.kind, components));
  const specs = lists[0].filter((spec) => lists.every((l) => l.some((o) => o.attr === spec.attr && o.kind === spec.kind)));
  for (const spec of specs) {
    if ((spec.attr === "id" || spec.attr === "name") && nodes.length > 1) continue;
    const values = nodes.map((n) => n.attrs[spec.attr]);
    const same = values.every((v) => v === values[0]);
    const raw = same ? values[0] : undefined;
    const shown = raw ?? (same ? (spec.fallback ?? "") : "");
    const row: PropertyDescriptor = {
      id: spec.attr,
      name: spec.raw ? spec.name : t(spec.name),
      category: spec.raw ? spec.category : t(spec.category),
      description: spec.raw ? spec.description : t(spec.description),
      value: shown,
      onCommit: (value: PropertyValue) => {
        const text = String(value).trim();
        // Choosing the default removes the attribute — the file stays minimal.
        const error = apply(spec.attr, text === "" || text === spec.fallback ? undefined : text);
        // Naming an event (as in Visual Studio's Events tab) takes you to its handler.
        if (!error && text !== "" && spec.category === "Events" && !spec.raw && events && nodes.length === 1 && SPECS.includes(spec)) events.open(nodes[0], spec.attr);
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
      row.validate = (value) => check(spec.kind, String(value));
      if (spec.kind === "image") {
        if (yuiPath) {
          row.suggestions = imageSources(yuiPath).map((c) => c.source);
          if (shown) row.image = imagePreview(yuiPath, shown) ?? undefined;
        }
        const alias = suggestImageAlias(shown);
        if (alias) row.description = `${row.description}\n\n${t("This is a raw resource path; use {alias} instead.", { alias })}`;
      }
      if (spec.kind === "color") {
        const color = parseColor(shown);
        if (color !== null) row.swatch = cssColor(color);
      }
    }
    if (same && raw === undefined && spec.fallback !== undefined && spec.kind !== "bool") row.displayValue = `${spec.fallback} ${t("(default)")}`;
    rows.push(row);
  }
  return rows;
}

/**
 * The `.yui` vocabulary for the XAML editor's completion — every element
 * with the attributes Properties offers for it, enum and boolean values
 * included, descriptions as completion info (in the current language).
 */
export function yuiSchema(): XmlSchema {
  const children = KINDS.filter((k) => k !== "Screen");
  return {
    elements: KINDS.map((kind) => ({
      name: kind,
      top: kind === "Screen",
      children: CONTAINER_KINDS.has(kind) ? children : [],
      completion: { info: t(KIND_INFO[kind].description) },
      attributes: SPECS.filter((spec) => applies(spec, kind)).map((spec) => ({
        name: spec.attr,
        values: spec.kind === "bool" ? ["true", "false"] : spec.kind === "enum" ? spec.options : spec.kind === "units" ? ["auto"] : spec.suggestions,
        completion: { info: t(spec.description), detail: spec.fallback !== undefined ? `= ${spec.fallback}` : undefined },
      })),
    })),
  };
}
