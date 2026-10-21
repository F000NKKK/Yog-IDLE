// The designer's widget model — a .yui tree as the layout reads it (mirrors
// `widget.rs`).

import { yui, screenAnchor } from "../data/yogIds.generated";
import { designImage, designText } from "../lang/designResources";
import { gridDefs, type TrackDef } from "./grid";
import { CANVAS_KINDS, parseColor, parseNumber, widgetChildren, type YuiNode } from "./yui";
import { DEFAULT_TEXT, TEXT_BOX_BG, TEXT_BOX_TEXT } from "./colors";

// ── Widget model (mirrors `widget.rs`) ───────────────────────────────────────

export type Units = { t: "auto" } | { t: "px"; v: number } | { t: "pct"; v: number };
export type Dock = "none" | "fill" | "left" | "right" | "top" | "bottom";
export type Align = "start" | "center" | "end";
export type HAlign = "left" | "center" | "right" | "stretch";
export type VAlign = "top" | "center" | "bottom" | "stretch";
export type Leaf = "panel" | "label" | "button" | "text_box" | "item_slot" | "inv_slot" | "image" | "spacer";

export interface Style {
  w: Units;
  h: Units;
  minW: number;
  minH: number;
  flex: number;
  dock: Dock;
  gap: number;
  pad: [number, number, number, number];
  /** Space outside the border: top, right, bottom, left. */
  margin: [number, number, number, number];
  /** Grid cell: row, column, row span, column span (`Grid.Row`, ...). */
  cell: [number, number, number, number];
  halign: HAlign | null;
  valign: VAlign | null;
  bg: number;
  color: number;
  align: Align;
  fontScale: number;
  shadow: boolean;
  noWrap: boolean;
  /** One line cut with `...` (implies `noWrap`). */
  ellipsis: boolean;
  /** Reserves `SCROLLBAR_W` on the right for a scrollbar (ScrollView). */
  scrollbar: boolean;
  /** Clips its children (ScrollView). */
  clip: boolean;
  pos: [number, number] | null;
}

export interface LWidget {
  /** The `.yui` node this came from (`""` for the screen-sized wrapper). */
  uid: string;
  kind: Leaf;
  dir: "row" | "column";
  text: string;
  /** A text box's greyed hint. */
  placeholder: string;
  item: string;
  count: number;
  /** An image's source. */
  source: string;
  style: Style;
  /** A `Grid`'s rows and columns (`null`: not a grid). */
  grid: { rows: TrackDef[]; cols: TrackDef[]; rowSpacing: number; colSpacing: number } | null;
  /** `false` = collapsed (`visible="false"`, or `d:visible` at design time): no space, not drawn — `Widget::visible`. */
  visible: boolean;
  children: LWidget[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A laid-out grid's rows and columns: `[start, size]`, absolute (`layout::GridLines`). */
export interface GridLines {
  rows: [number, number][];
  cols: [number, number][];
  /** Track sizes from a measure along an unbounded axis (see `sizeAxis`). */
  floorRows: number[];
  floorCols: number[];
}

export interface LNode {
  uid: string;
  rect: Rect;
  children: LNode[];
  grid?: GridLines;
}

export function resolve(u: Units, avail: number): number | null {
  if (u.t === "auto") return null;
  if (u.t === "px") return u.v;
  return (avail * u.v) / 100;
}

export function defaultStyle(): Style {
  return {
    w: { t: "auto" },
    h: { t: "auto" },
    minW: 4,
    minH: 4,
    flex: 0,
    dock: "none",
    gap: 2,
    pad: [0, 0, 0, 0],
    margin: [0, 0, 0, 0],
    cell: [0, 0, 1, 1],
    halign: null,
    valign: null,
    bg: 0,
    color: DEFAULT_TEXT,
    align: "start",
    fontScale: 1,
    shadow: true,
    noWrap: false,
    ellipsis: false,
    scrollbar: false,
    clip: false,
    pos: null,
  };
}

export function units(value: string | undefined): Units {
  const v = value?.trim() ?? "";
  if (v === "" || v === "auto") return { t: "auto" };
  if (v.endsWith("%")) {
    const n = parseNumber(v.slice(0, -1));
    return n === null ? { t: "auto" } : { t: "pct", v: n };
  }
  const n = parseNumber(v);
  return n === null ? { t: "auto" } : { t: "px", v: n };
}

export function parsePadding(value: string | undefined): [number, number, number, number] {
  const parts = (value ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((p) => parseNumber(p) ?? 0);
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 4) return [parts[0], parts[1], parts[2], parts[3]];
  return [0, 0, 0, 0];
}

export const LEAF_OF: Record<string, Leaf> = {
  Screen: "panel",
  Canvas: "panel",
  Column: "panel",
  Row: "panel",
  ScrollView: "panel",
  Grid: "panel",
  Label: "label",
  Button: "button",
  TextBox: "text_box",
  ItemSlot: "item_slot",
  InvSlot: "inv_slot",
  Slot: "inv_slot",
  PlayerInventory: "panel",
  RecipeArea: "panel",
  Image: "image",
  Spacer: "spacer",
  RecipeSlot: "item_slot",
  RecipeResult: "item_slot",
  RecipeCount: "label",
};

/** A flag attribute at design time: only a literal `false` is false (a `{x:Bind ...}` shows as true). */
export function designFlag(value: string | undefined): boolean {
  return value?.trim() !== "false";
}

/** The widget a `.yui` node becomes — what its generated builder code would build. Lenient: a bad value falls back to the default. */
export function toWidget(node: YuiNode, inCanvas: boolean): LWidget {
  const a = node.attrs;
  const kind = LEAF_OF[node.kind] ?? "spacer";
  const style = defaultStyle();
  // Constructors that set a size (`inv_slot`).
  if (kind === "inv_slot") {
    style.w = { t: "px", v: 18 };
    style.h = { t: "px", v: 18 };
  } else if (kind === "text_box") {
    // `widget::text_box`: black box, light text, 4 px side padding.
    style.bg = TEXT_BOX_BG;
    style.color = TEXT_BOX_TEXT;
    style.pad = [0, 4, 0, 4];
  }
  if (node.kind === yui.SCREEN) {
    const w = parseNumber(a.width);
    const h = parseNumber(a.height);
    if (w !== null) style.w = { t: "px", v: w };
    if (h !== null) style.h = { t: "px", v: h };
  }
  const x = parseNumber(a.x);
  const y = parseNumber(a.y);
  if (inCanvas || x !== null || y !== null) style.pos = [x ?? 0, y ?? 0];
  if (a.w !== undefined && units(a.w).t !== "auto") style.w = units(a.w);
  if (a.h !== undefined && units(a.h).t !== "auto") style.h = units(a.h);
  style.minW = parseNumber(a.min_w) ?? style.minW;
  style.minH = parseNumber(a.min_h) ?? style.minH;
  style.flex = parseNumber(a.flex) ?? style.flex;
  style.gap = parseNumber(a.gap) ?? style.gap;
  style.fontScale = parseNumber(a.font_scale) ?? style.fontScale;
  if (a.dock && ["none", "fill", "left", "right", "top", "bottom"].includes(a.dock)) style.dock = a.dock as Dock;
  if (a.align && ["start", "center", "end"].includes(a.align)) style.align = a.align as Align;
  if (a.padding !== undefined) style.pad = parsePadding(a.padding);
  if (a.margin !== undefined) style.margin = parsePadding(a.margin);
  if (a.halign && ["left", "center", "right", "stretch"].includes(a.halign)) style.halign = a.halign as HAlign;
  if (a.valign && ["top", "center", "bottom", "stretch"].includes(a.valign)) style.valign = a.valign as VAlign;
  const index = (v: string | undefined, min: number, fallback: number) => {
    const n = parseNumber(v);
    return n === null || n < min ? fallback : Math.floor(n);
  };
  style.cell = [index(a["Grid.Row"], 0, 0), index(a["Grid.Column"], 0, 0), index(a["Grid.RowSpan"], 1, 1), index(a["Grid.ColumnSpan"], 1, 1)];
  style.bg = parseColor(a.bg) ?? style.bg;
  style.color = parseColor(a.color) ?? style.color;
  if (a.shadow === "false") style.shadow = false;
  if (a.no_wrap === "true") style.noWrap = true;
  if (a.ellipsis === "true") style.noWrap = style.ellipsis = true;
  if (node.kind === yui.SCROLL_VIEW) style.scrollbar = style.clip = true;
  const canvas = CANVAS_KINDS.has(node.kind);
  const defs = node.kind === yui.GRID ? gridDefs(node) : null;
  return {
    uid: node.uid,
    kind,
    dir: node.kind === yui.ROW ? "row" : "column",
    text: designText(a.text ?? ""),
    placeholder: designText(a.placeholder ?? ""),
    item: a.item ?? "",
    count: Math.max(0, Math.floor(parseNumber(a.count) ?? 1)),
    source: designImage(a.source ?? ""),
    style,
    grid: defs && {
      rows: defs.rows,
      cols: defs.cols,
      rowSpacing: Math.max(0, parseNumber(a.row_spacing) ?? 0),
      colSpacing: Math.max(0, parseNumber(a.column_spacing) ?? 0),
    },
    visible: designFlag(a["d:visible"] ?? a.visible),
    children: LEAF_OF[node.kind] === "panel" ? widgetChildren(node).map((c) => toWidget(c, canvas)) : [],
  };
}

/** Where the generated `root_with` puts the screen inside a `screenW` × `screenH` GUI. */
export function anchorOffset(anchor: string | undefined, screenW: number, screenH: number, w: number, h: number): [number, number] {
  const cx = Math.max(0, Math.floor((screenW - w) / 2));
  const cy = Math.max(0, Math.floor((screenH - h) / 2));
  const r = Math.max(0, screenW - w);
  const b = Math.max(0, screenH - h);
  switch (anchor) {
    case screenAnchor.TOP_LEFT:
    case screenAnchor.FILL:
      return [0, 0];
    case screenAnchor.TOP:
      return [cx, 0];
    case screenAnchor.TOP_RIGHT:
      return [r, 0];
    case screenAnchor.LEFT:
      return [0, cy];
    case screenAnchor.RIGHT:
      return [r, cy];
    case screenAnchor.BOTTOM_LEFT:
      return [0, b];
    case screenAnchor.BOTTOM:
      return [cx, b];
    case screenAnchor.BOTTOM_RIGHT:
      return [r, b];
    default:
      return [cx, cy];
  }
}

/** The whole GUI: a screen-sized column holding the `Screen` placed per its anchor — exactly `root_with`. */
export function screenWidget(screen: YuiNode, screenW: number, screenH: number): LWidget {
  const content = toWidget(screen, false);
  const w = parseNumber(screen.attrs.width) ?? 176;
  const h = parseNumber(screen.attrs.height) ?? 166;
  if (screen.attrs.anchor === "fill") {
    content.style.w = { t: "pct", v: 100 };
    content.style.h = { t: "pct", v: 100 };
    content.style.pos = [0, 0];
  } else {
    content.style.pos = anchorOffset(screen.attrs.anchor, screenW, screenH, w, h);
  }
  const wrapper = toWidget({ uid: "", kind: yui.COLUMN, attrs: {}, children: [] }, false);
  wrapper.uid = "";
  wrapper.style.w = { t: "px", v: screenW };
  wrapper.style.h = { t: "px", v: screenH };
  wrapper.children = [content];
  return wrapper;
}
