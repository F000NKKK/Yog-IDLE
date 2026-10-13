// What the Properties window shows for the widgets selected in the screen
// designer — one row per `.yui` attribute the selection can have.

import { t, type PropertyDescriptor, type PropertyValue, type XmlSchema } from "substrate-platform-ui";
import { CONTAINER_KINDS, cssColor, KIND_INFO, KINDS, parseColor, parseNumber, type YuiNode } from "./yui";

type AttrKind = "text" | "number" | "units" | "color" | "bool" | "enum" | "padding";

interface AttrSpec {
  attr: string;
  /** English; shown through `t`. */
  name: string;
  category: "Design" | "Layout" | "Appearance" | "Behavior" | "Events" | "Data" | "Screen";
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
  { attr: "texture", name: "Texture", category: "Data", kind: "text", only: ["Image"], description: "A texture from a resource pack, as `namespace:path/to/file.png`." },
  { attr: "tex_w", name: "Texture Width", category: "Data", kind: "number", fallback: "16", only: ["Image"], description: "The texture's width in pixels (also the image's default width)." },
  { attr: "tex_h", name: "Texture Height", category: "Data", kind: "number", fallback: "16", only: ["Image"], description: "The texture's height in pixels (also the image's default height)." },
];

const applies = (spec: AttrSpec, kind: string) => (!spec.only || spec.only.includes(kind)) && !spec.not?.includes(kind);

/** Rejects a value the generator wouldn't accept (`yog ui gen` checks the same). */
function check(kind: AttrKind, value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  switch (kind) {
    case "number":
      return parseNumber(v) === null ? t("Expected a number.") : null;
    case "units":
      return v === "auto" || parseNumber(v.endsWith("%") ? v.slice(0, -1) : v) !== null ? null : t("Expected pixels (80), a percentage (50%) or auto.");
    case "color":
      return parseColor(v) === null ? t("Expected a color like #RRGGBB or #AARRGGBB.") : null;
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
export function widgetProperties(nodes: YuiNode[], apply: (attr: string, value: string | undefined) => string | null, events?: EventActions): PropertyDescriptor[] {
  if (nodes.length === 0) return [];
  const rows: PropertyDescriptor[] = [];
  for (const spec of SPECS) {
    if (!nodes.every((n) => applies(spec, n.kind))) continue;
    if (spec.attr === "id" && nodes.length > 1) continue;
    const values = nodes.map((n) => n.attrs[spec.attr]);
    const same = values.every((v) => v === values[0]);
    const raw = same ? values[0] : undefined;
    const shown = raw ?? (same ? (spec.fallback ?? "") : "");
    const row: PropertyDescriptor = {
      id: spec.attr,
      name: t(spec.name),
      category: t(spec.category),
      description: t(spec.description),
      value: shown,
      onCommit: (value: PropertyValue) => {
        const text = String(value).trim();
        // Choosing the default removes the attribute — the file stays minimal.
        const error = apply(spec.attr, text === "" || text === spec.fallback ? undefined : text);
        // Naming an event (as in Visual Studio's Events tab) takes you to its handler.
        if (!error && text !== "" && spec.category === "Events" && events && nodes.length === 1) events.open(nodes[0], spec.attr);
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
      row.suggestions = spec.category === "Events" && events && nodes.length === 1 && !raw ? [events.suggest(nodes[0], spec.attr)] : spec.suggestions;
      row.validate = (value) => check(spec.kind, String(value));
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
