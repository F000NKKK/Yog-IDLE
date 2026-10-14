// A line-for-line port of yog-ui's layout (`layout.rs`) and text metrics
// (`text.rs`), so the designer places every widget exactly where the game
// will. Keep in step with the crate.

import { designImage, designText } from "../lang/designResources";
import { gridDefs, type GridLength, type TrackDef } from "./grid";
import { CANVAS_KINDS, parseColor, parseNumber, widgetChildren, type YuiNode } from "./yui";

export const LINE_H = 9;
export const LINE_GAP = 1;
const F32_MAX = 3.4028235e38;

export function charWidth(c: string): number {
  switch (c) {
    case " ":
      return 4;
    case "!":
    case ",":
    case ".":
    case ":":
    case ";":
    case "|":
    case "'":
    case "i":
      return 2;
    case "l":
    case "`":
      return 3;
    case "(":
    case ")":
    case "*":
    case "<":
    case ">":
    case "{":
    case "}":
    case "f":
    case "k":
    case '"':
      return 5;
    case "t":
    case "[":
    case "]":
    case "I":
      return 4;
    case "@":
    case "~":
      return 7;
    default:
      return 6;
  }
}

export function strWidth(s: string, scale: number): number {
  let w = 0;
  for (const c of s) w += charWidth(c);
  return w * scale;
}

function wrapText(text: string, maxW: number, scale: number): string[] {
  if (scale <= 0 || maxW <= 0) return [text];
  const spaceW = charWidth(" ") * scale;
  const lines: string[] = [];
  let cur = "";
  let curW = 0;
  const append = (word: string, wordW: number) => {
    if (wordW <= maxW) {
      cur = word;
      curW = wordW;
      return;
    }
    let line = "";
    let w = 0;
    for (const ch of word) {
      const cw = charWidth(ch) * scale;
      if (w + cw > maxW && line !== "") {
        lines.push(line);
        line = "";
        w = 0;
      }
      line += ch;
      w += cw;
    }
    cur = line;
    curW = w;
  };
  for (const word of text.split(" ")) {
    if (word === "") continue;
    const wordW = strWidth(word, scale);
    if (curW === 0) append(word, wordW);
    else if (curW + spaceW + wordW <= maxW) {
      cur += " " + word;
      curW += spaceW + wordW;
    } else {
      lines.push(cur);
      cur = "";
      curW = 0;
      append(word, wordW);
    }
  }
  if (curW > 0 || lines.length === 0) lines.push(cur);
  return lines;
}

/** `line` cut with `...` to fit `maxW` — `render.rs`'s `ellipsize`. */
function ellipsize(line: string, maxW: number, scale: number): string {
  if (strWidth(line, scale) <= maxW) return line;
  const budget = maxW - strWidth("...", scale);
  let out = "";
  let w = 0;
  for (const c of line) {
    const cw = charWidth(c) * scale;
    if (w + cw > budget) break;
    out += c;
    w += cw;
  }
  return out.trimEnd() + "...";
}

/** The lines a label/button draws in `availW` — `render.rs`'s `text_lines`. */
export function textLines(text: string, s: Style, availW: number): string[] {
  if (s.ellipsis) return [ellipsize(text, availW, s.fontScale)];
  return s.noWrap ? [text] : wrapText(text, availW, s.fontScale);
}

/** Width of the strip a ScrollView reserves for its scrollbar (`layout::SCROLLBAR_W`). */
const SCROLLBAR_W = 6;

function textHeight(text: string, maxW: number, scale: number): number {
  const n = Math.max(1, wrapText(text, maxW, scale).length);
  return n * LINE_H * scale + Math.max(0, n - 1) * LINE_GAP;
}

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

function resolve(u: Units, avail: number): number | null {
  if (u.t === "auto") return null;
  if (u.t === "px") return u.v;
  return (avail * u.v) / 100;
}

function defaultStyle(): Style {
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
    color: 0xffccccaa,
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

function units(value: string | undefined): Units {
  const v = value?.trim() ?? "";
  if (v === "" || v === "auto") return { t: "auto" };
  if (v.endsWith("%")) {
    const n = parseNumber(v.slice(0, -1));
    return n === null ? { t: "auto" } : { t: "pct", v: n };
  }
  const n = parseNumber(v);
  return n === null ? { t: "auto" } : { t: "px", v: n };
}

function parsePadding(value: string | undefined): [number, number, number, number] {
  const parts = (value ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((p) => parseNumber(p) ?? 0);
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 4) return [parts[0], parts[1], parts[2], parts[3]];
  return [0, 0, 0, 0];
}

const LEAF_OF: Record<string, Leaf> = {
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
function designFlag(value: string | undefined): boolean {
  return value?.trim() !== "false";
}

/** The widget a `.yui` node becomes — what its generated builder code would build. Lenient: a bad value falls back to the default. */
function toWidget(node: YuiNode, inCanvas: boolean): LWidget {
  const a = node.attrs;
  const kind = LEAF_OF[node.kind] ?? "spacer";
  const style = defaultStyle();
  // Constructors that set a size (`inv_slot`).
  if (kind === "inv_slot") {
    style.w = { t: "px", v: 18 };
    style.h = { t: "px", v: 18 };
  } else if (kind === "text_box") {
    // `widget::text_box`: black box, light text, 4 px side padding.
    style.bg = 0xff000000;
    style.color = 0xffe0e0e0;
    style.pad = [0, 4, 0, 4];
  }
  if (node.kind === "Screen") {
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
  if (node.kind === "ScrollView") style.scrollbar = style.clip = true;
  const canvas = CANVAS_KINDS.has(node.kind);
  const defs = node.kind === "Grid" ? gridDefs(node) : null;
  return {
    uid: node.uid,
    kind,
    dir: node.kind === "Row" ? "row" : "column",
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
function anchorOffset(anchor: string | undefined, screenW: number, screenH: number, w: number, h: number): [number, number] {
  const cx = Math.max(0, Math.floor((screenW - w) / 2));
  const cy = Math.max(0, Math.floor((screenH - h) / 2));
  const r = Math.max(0, screenW - w);
  const b = Math.max(0, screenH - h);
  switch (anchor) {
    case "top_left":
    case "fill":
      return [0, 0];
    case "top":
      return [cx, 0];
    case "top_right":
      return [r, 0];
    case "left":
      return [0, cy];
    case "right":
      return [r, cy];
    case "bottom_left":
      return [0, b];
    case "bottom":
      return [cx, b];
    case "bottom_right":
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
  const wrapper = toWidget({ uid: "", kind: "Column", attrs: {}, children: [] }, false);
  wrapper.uid = "";
  wrapper.style.w = { t: "px", v: screenW };
  wrapper.style.h = { t: "px", v: screenH };
  wrapper.children = [content];
  return wrapper;
}

// ── Layout (mirrors `layout.rs` and `layout/grid.rs`) ────────────────────────
//
// Percent sizes resolve once, against the parent's content box; along an
// axis still being measured for content (unbounded) they act as `auto`.
// Grown (flex) sizes stick: children are re-laid against the final size.

export function compute(w: LWidget, availW: number, availH: number): LNode {
  const node: LNode = { uid: w.uid, rect: { x: 0, y: 0, w: 0, h: 0 }, children: [] };
  measured = new Map();
  try {
    layoutWidget(w, node, 0, 0, availW, availH, availW, availH);
  } finally {
    measured = null;
  }
  return node;
}

/** "No size cap: measure to content" (`layout::UNBOUNDED`). */
const UNBOUNDED = F32_MAX;
const bounded = (v: number) => v < UNBOUNDED / 2;

function resolveSize(u: Units, basis: number): number | null {
  if (u.t === "pct" && !bounded(basis)) return null;
  return resolve(u, basis);
}

/** `v` less `by` (at least 0); unbounded stays unbounded. */
const less = (v: number, by: number) => (bounded(v) ? Math.max(0, v - by) : UNBOUNDED);

/** Margin `side` of a visible child (a collapsed one has none). */
const visMargin = (c: LWidget, side: number) => (c.visible ? c.style.margin[side] : 0);

/** Lays out children (a grid does even with none: its tracks size it). */
const isContainer = (w: LWidget) => w.children.length > 0 || w.grid !== null;

const newNode = (w: LWidget): LNode => ({ uid: w.uid, rect: { x: 0, y: 0, w: 0, h: 0 }, children: [] });

interface Shrink {
  w: boolean;
  h: boolean;
  maxW: number;
  maxH: number;
}

/** A widget measured at the origin under some constraints, as `layoutWidget` left its node. */
interface Measured {
  maxW: number;
  maxH: number;
  basisW: number;
  basisH: number;
  w: number;
  h: number;
  grid: LNode["grid"];
  children: LNode[];
}

/**
 * This `compute` pass's measurements. A container measures each child, then
 * arranges it — which measures the grandchildren again under the same
 * constraints, and so on down: without this, the work doubles per nesting
 * level. A measurement only depends on the widget and its constraints (the
 * origin is always 0, 0), so a repeat is answered from here.
 */
let measured: Map<LWidget, Measured[]> | null = null;

function layoutWidget(w: LWidget, node: LNode, x: number, y: number, maxW: number, maxH: number, basisW: number, basisH: number) {
  if (!measured || x !== 0 || y !== 0) return measureWidget(w, node, x, y, maxW, maxH, basisW, basisH);
  let list = measured.get(w);
  const hit = list?.find((m) => m.maxW === maxW && m.maxH === maxH && m.basisW === basisW && m.basisH === basisH);
  if (hit) {
    node.rect = { x: 0, y: 0, w: hit.w, h: hit.h };
    node.grid = hit.grid;
    node.children = hit.children;
    return;
  }
  measureWidget(w, node, 0, 0, maxW, maxH, basisW, basisH);
  if (!list) measured.set(w, (list = []));
  list.push({ maxW, maxH, basisW, basisH, w: node.rect.w, h: node.rect.h, grid: node.grid, children: node.children });
}

function measureWidget(w: LWidget, node: LNode, x: number, y: number, maxW: number, maxH: number, basisW: number, basisH: number) {
  const s = w.style;
  const hasChildren = isContainer(w);
  const rw = resolveSize(s.w, basisW);
  const rh = resolveSize(s.h, basisH);
  const explicitW = rw === null ? null : Math.min(rw, maxW);
  const explicitH = rh === null ? null : Math.min(rh, maxH);
  let ww = explicitW ?? maxW;
  let hh = explicitH ?? maxH;

  if (!hasChildren) {
    switch (w.kind) {
      case "label":
      case "button": {
        const availW = Math.max(0, (explicitW ?? maxW) - s.pad[1] - s.pad[3]);
        if (availW < 4096 && !s.noWrap) {
          ww = Math.min(Math.max(availW + s.pad[1] + s.pad[3], s.minW), maxW);
          hh = Math.min(Math.max(textHeight(w.text, availW, s.fontScale) + s.pad[0] + s.pad[2], s.minH), maxH);
        } else {
          const tw = strWidth(w.text, s.fontScale);
          ww = Math.min(Math.max(tw + s.pad[1] + s.pad[3], s.minW), maxW);
          hh = Math.min(Math.max(LINE_H * s.fontScale + s.pad[0] + s.pad[2], s.minH), maxH);
        }
        break;
      }
      case "text_box":
        // The available width (100 when unbounded), one line plus border and padding.
        if (!bounded(ww)) ww = 100;
        ww = Math.min(Math.max(ww, s.minW), maxW);
        hh = Math.min(Math.max(LINE_H * s.fontScale + 7 + s.pad[0] + s.pad[2], s.minH), maxH);
        break;
      case "item_slot":
      case "inv_slot":
        ww = Math.min(Math.max(18 + s.pad[1] + s.pad[3], s.minW), maxW);
        hh = Math.min(Math.max(18 + s.pad[0] + s.pad[2], s.minH), maxH);
        break;
      case "spacer":
        ww = Math.min(Math.max(s.minW, 1), maxW);
        hh = Math.min(Math.max(s.minH, 1), maxH);
        break;
      case "panel":
        if (!bounded(ww)) ww = s.minW;
        if (!bounded(hh)) hh = s.minH;
        break;
      case "image":
        // The designer's natural size of an image: an item icon's.
        ww = Math.min(Math.max(16 + s.pad[1] + s.pad[3], s.minW), maxW);
        hh = Math.min(Math.max(16 + s.pad[0] + s.pad[2], s.minH), maxH);
        break;
    }
    if (explicitW !== null) ww = explicitW;
    if (explicitH !== null) hh = explicitH;
  }

  node.rect = { x, y, w: ww, h: hh };
  node.grid = undefined;
  if (hasChildren) layoutChildren(w, node, { w: explicitW === null, h: explicitH === null, maxW, maxH });
}

/** Final rect for an already measured widget; children lay out against it. */
function arrange(w: LWidget, node: LNode, x: number, y: number) {
  node.rect.x = x;
  node.rect.y = y;
  if (isContainer(w)) layoutChildren(w, node, null);
}

/**
 * Measures `w` aligned (not stretched) across a `maxW` slot: at its content
 * width — text takes the width it needs instead of wrapping at (and filling)
 * the slot — unless that's wider than the slot.
 */
function measureAligned(w: LWidget, node: LNode, maxW: number, maxH: number, basisW: number, basisH: number) {
  if (bounded(maxW) && w.style.w.t === "auto") {
    layoutWidget(w, node, 0, 0, UNBOUNDED, maxH, basisW, basisH);
    if (node.rect.w <= maxW) return;
  }
  layoutWidget(w, node, 0, 0, maxW, maxH, basisW, basisH);
}

type SelfPlace = Align | "stretch" | null;

function layoutChildren(w: LWidget, node: LNode, shrink: Shrink | null) {
  if (w.grid) return layoutGrid(w, w.grid, node, shrink);
  const s = w.style;
  const { x, y, w: ww, h: hh } = node.rect;
  const dir = w.kind === "panel" && w.dir === "row" ? "row" : "column";
  const barW = s.scrollbar ? SCROLLBAR_W : 0;
  const contentW = bounded(ww) ? Math.max(0, ww - s.pad[1] - s.pad[3] - barW) : UNBOUNDED;
  const contentH = bounded(hh) ? Math.max(0, hh - s.pad[0] - s.pad[2]) : UNBOUNDED;
  const mainBounded = bounded(dir === "row" ? contentW : contentH);
  const crossBounded = bounded(dir === "row" ? contentH : contentW);
  // Measuring an auto-sized cross axis: nothing is centred/end-aligned until the arrange pass.
  const crossShrinks = !!shrink && (dir === "row" ? shrink.h : shrink.w);
  // A child's own cross-axis placement (`halign` in a Column, `valign` in a Row).
  const selfPlace = (c: LWidget): SelfPlace => {
    const a = dir === "column" ? c.style.halign : c.style.valign;
    if (a === null) return null;
    if (a === "stretch") return "stretch";
    return a === "left" || a === "top" ? "start" : a === "center" ? "center" : "end";
  };
  const crossOffset = (c: LWidget, content: number, size: number) => {
    if (!crossBounded || crossShrinks) return 0;
    const p = selfPlace(c);
    const a = p === null || p === "stretch" ? s.align : p;
    return a === "center" ? (content - size) / 2 : a === "end" ? content - size : 0;
  };
  /** Margins along the main axis: [leading, total]. */
  const mainM = (c: LWidget): [number, number] => {
    const m = c.style.margin;
    return dir === "row" ? [m[3], m[1] + m[3]] : [m[0], m[0] + m[2]];
  };
  const crossM = (c: LWidget): [number, number] => {
    const m = c.style.margin;
    return dir === "row" ? [m[0], m[0] + m[2]] : [m[3], m[1] + m[3]];
  };
  const effectiveFlex = (c: LWidget) => (c.style.dock === "fill" ? Math.max(c.style.flex, 1) : c.style.flex);
  const inFlow = (c: LWidget) => c.visible && c.style.pos === null && !((dir === "row" && c.style.dock === "right") || (dir === "column" && c.style.dock === "bottom"));
  const stretches = (c: LWidget) => {
    const dock = c.style.dock;
    const autoCross = (dir === "row" ? c.style.h : c.style.w).t === "auto";
    return (
      crossBounded &&
      ((dir === "row" ? dock === "fill" || dock === "left" || dock === "right" : dock === "fill" || dock === "top" || dock === "bottom") ||
        (autoCross && selfPlace(c) === "stretch"))
    );
  };

  const childNodes: LNode[] = [];
  let totalFlex = 0;
  let usedMain = 0;
  for (const child of w.children) {
    const cn = newNode(child);
    if (!child.visible) {
      // Collapsed: a zero rect at the content box's corner, out of the flow.
      cn.rect = { x: x + s.pad[3], y: y + s.pad[0], w: 0, h: 0 };
      childNodes.push(cn);
      continue;
    }
    const m = child.style.margin;
    if (child.style.pos) {
      const [px, py] = child.style.pos;
      layoutWidget(child, cn, 0, 0, less(contentW, px + m[1] + m[3]), less(contentH, py + m[0] + m[2]), contentW, contentH);
      childNodes.push(cn);
      continue;
    }
    let cmw: number;
    let cmh: number;
    if (child.style.dock === "fill") [cmw, cmh] = [contentW, contentH];
    else if (dir === "row") [cmw, cmh] = [UNBOUNDED, contentH];
    else [cmw, cmh] = [contentW, UNBOUNDED];
    [cmw, cmh] = [less(cmw, m[1] + m[3]), less(cmh, m[0] + m[2])];
    const place = selfPlace(child);
    if (dir === "column" && child.style.dock !== "fill" && place !== null && place !== "stretch") measureAligned(child, cn, cmw, cmh, contentW, contentH);
    else layoutWidget(child, cn, 0, 0, cmw, cmh, contentW, contentH);
    const ef = effectiveFlex(child);
    // A growing child starts from its min size, not its content (star sizing).
    if (ef > 0 && mainBounded && inFlow(child)) {
      if (dir === "row" && child.style.w.t === "auto") cn.rect.w = child.style.minW;
      if (dir === "column" && child.style.h.t === "auto") cn.rect.h = child.style.minH;
    }
    usedMain += mainM(child)[1] + (dir === "row" ? cn.rect.w : cn.rect.h);
    if (inFlow(child)) totalFlex += ef;
    childNodes.push(cn);
  }
  const placed = w.children.filter((c) => c.visible && c.style.pos === null).length;
  usedMain += s.gap * Math.max(0, placed - 1);
  const available = mainBounded ? (dir === "row" ? contentW : contentH) - usedMain : 0;
  let pos = dir === "row" ? s.pad[3] : s.pad[0];

  w.children.forEach((child, i) => {
    if (!inFlow(child)) return;
    const cn = childNodes[i];
    const ef = effectiveFlex(child);
    const grow = ef > 0 && totalFlex > 0 && available > 0 ? (available * ef) / totalFlex : 0;
    const stretch = stretches(child);
    const [ml, mt] = mainM(child);
    const [cl, ct] = crossM(child);
    let cx: number;
    let cy: number;
    if (dir === "row") {
      cn.rect.w += grow;
      if (stretch) cn.rect.h = Math.max(0, contentH - ct);
      cx = x + pos + ml;
      cy = y + s.pad[0] + cl + crossOffset(child, contentH, cn.rect.h + ct);
      pos += cn.rect.w + mt + s.gap;
    } else {
      cn.rect.h += grow;
      if (stretch) cn.rect.w = Math.max(0, contentW - ct);
      cx = x + s.pad[3] + cl + crossOffset(child, contentW, cn.rect.w + ct);
      cy = y + pos + ml;
      pos += cn.rect.h + mt + s.gap;
    }
    arrange(child, cn, cx, cy);
  });

  let rpos: number;
  if (mainBounded) rpos = dir === "row" ? x + s.pad[3] + contentW : y + s.pad[0] + contentH;
  else {
    const docked = w.children.map((c, i) => [c, childNodes[i]] as const).filter(([c]) => c.visible && !inFlow(c) && c.style.pos === null);
    const span = docked.reduce((sum, [c, n]) => sum + mainM(c)[1] + (dir === "row" ? n.rect.w : n.rect.h), 0) + s.gap * Math.max(0, docked.length - 1);
    rpos = (dir === "row" ? x : y) + pos + span;
  }
  w.children.forEach((child, i) => {
    if (!child.visible || inFlow(child) || child.style.pos) return;
    const cn = childNodes[i];
    const stretch = stretches(child);
    const [ml, mt] = mainM(child);
    const [cl, ct] = crossM(child);
    // The trailing margin first (it's on the far side).
    rpos -= mt - ml;
    let cx: number;
    let cy: number;
    if (dir === "row") {
      if (stretch) cn.rect.h = Math.max(0, contentH - ct);
      rpos -= cn.rect.w;
      cx = rpos;
      cy = y + s.pad[0] + cl + crossOffset(child, contentH, cn.rect.h + ct);
    } else {
      if (stretch) cn.rect.w = Math.max(0, contentW - ct);
      rpos -= cn.rect.h;
      cx = x + s.pad[3] + cl + crossOffset(child, contentW, cn.rect.w + ct);
      cy = rpos;
    }
    rpos -= ml + s.gap;
    arrange(child, cn, cx, cy);
  });

  w.children.forEach((child, i) => {
    if (!child.style.pos || !child.visible) return;
    const m = child.style.margin;
    arrange(child, childNodes[i], x + s.pad[3] + child.style.pos[0] + m[3], y + s.pad[0] + child.style.pos[1] + m[0]);
  });

  finish(w, node, childNodes, shrink, barW);
}

/** The end of a container's layout: with `shrink`, auto axes fit the children (margins included). */
function finish(w: LWidget, node: LNode, childNodes: LNode[], shrink: Shrink | null, barW: number) {
  const s = w.style;
  const { x, y } = node.rect;
  const extent = (f: (c: LWidget, n: LNode) => number) => w.children.reduce((m, c, i) => Math.max(m, f(c, childNodes[i])), 0);
  if (shrink) {
    if (shrink.w) {
      const cw = extent((c, n) => n.rect.x - x + n.rect.w + visMargin(c, 1));
      node.rect.w = Math.min(Math.max(cw + s.pad[1] + barW, s.minW), shrink.maxW);
    }
    if (shrink.h) {
      const ch = extent((c, n) => n.rect.y - y + n.rect.h + visMargin(c, 2));
      node.rect.h = Math.min(Math.max(ch + s.pad[2], s.minH), shrink.maxH);
    }
  }
  node.children = childNodes;
}

// ── Grid (mirrors `layout/grid.rs`) ──────────────────────────────────────────

interface Track {
  size: GridLength;
  min: number;
  max: number;
}

const ONE_STAR: Track[] = [{ size: { t: "star", v: 1 }, min: 0, max: Infinity }];

const toTrack = (d: TrackDef): Track => ({ size: d.size, min: Math.max(0, d.min ?? 0), max: d.max ?? Infinity });

/** A track sized to content: `Auto`, or `*` along an unbounded axis. */
const autoLike = (t: Track, flex: boolean) => t.size.t === "auto" || (t.size.t === "star" && !flex);
const isStar = (t: Track, flex: boolean) => flex && t.size.t === "star";
/** `v` within the track's limits (min wins over max, like WPF). */
const clampTrack = (t: Track, v: number) => Math.max(Math.min(v, t.max), t.min);

/** The space `start..end` covers, spacing between them included. */
function extentOf(sizes: number[], spacing: number, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += sizes[i];
  return sum + spacing * Math.max(0, end - start - 1);
}

/** A child's size along an axis when measured for auto tracks (`measure_cap`). */
function measureCap(tracks: Track[], spacing: number, avail: number, start: number, end: number): number {
  const flex = bounded(avail);
  const span = tracks.slice(start, end);
  if (span.every((t) => t.size.t === "px")) {
    const sizes = span.map((t) => (t.size.t === "px" ? clampTrack(t, t.size.v) : 0));
    return extentOf(sizes, spacing, 0, sizes.length);
  }
  return span.some((t) => isStar(t, flex)) ? avail : UNBOUNDED;
}

/** Track sizes along one axis of `avail` (`size_axis`). `items`: `[start, end, size]` of children sizing auto tracks. */
function sizeAxis(tracks: Track[], avail: number, spacing: number, items: [number, number, number][], floor: number[]): number[] {
  const flex = bounded(avail);
  const size = tracks.map((t) => clampTrack(t, t.size.t === "px" ? t.size.v : 0));

  // Auto tracks: single spans, then wider ones only add what's missing.
  items.sort((a, b) => a[1] - a[0] - (b[1] - b[0]));
  for (const [s, e, want] of items) {
    if (e - s === 1) {
      if (autoLike(tracks[s], flex)) size[s] = clampTrack(tracks[s], Math.max(size[s], want));
      continue;
    }
    let missing = want - extentOf(size, spacing, s, e);
    while (missing > 0.01) {
      const growable: number[] = [];
      for (let i = s; i < e; i++) if (autoLike(tracks[i], flex) && size[i] < tracks[i].max) growable.push(i);
      if (growable.length === 0) break;
      const share = missing / growable.length;
      for (const i of growable) {
        const add = Math.min(share, tracks[i].max - size[i]);
        size[i] += add;
        missing -= add;
      }
    }
  }

  // Star tracks share what's left.
  if (flex) {
    let open = tracks.map((_, i) => i).filter((i) => isStar(tracks[i], flex));
    const fixed = size.reduce((sum, v, i) => (open.includes(i) ? sum : sum + v), 0);
    let rest = avail - fixed - spacing * Math.max(0, tracks.length - 1);
    // Measured to content, then arranged at that size: `*` tracks keep their content size if it fits.
    const t =
      floor.length === tracks.length && open.reduce((sum, i) => sum + floor[i], 0) <= rest + 0.01
        ? tracks.map((tr, i) => ({ ...tr, min: Math.max(tr.min, floor[i]) }))
        : tracks;
    const weight = (i: number) => (t[i].size.t === "star" ? Math.max(0, (t[i].size as { v: number }).v) : 0);
    while (open.length > 0) {
      const total = open.reduce((sum, i) => sum + weight(i), 0);
      if (total <= 0) {
        for (const i of open) size[i] = clampTrack(t[i], 0);
        break;
      }
      const per = Math.max(0, rest) / total;
      // A track whose share breaks a limit takes the limit and drops out; min violations first.
      const under = open.filter((i) => per * weight(i) < t[i].min);
      const over = open.filter((i) => per * weight(i) > Math.max(t[i].max, t[i].min));
      const fix = under.length > 0 ? under : over;
      if (fix.length === 0) {
        for (const i of open) size[i] = per * weight(i);
        break;
      }
      for (const i of fix) {
        size[i] = clampTrack(t[i], per * weight(i));
        rest -= size[i];
      }
      open = open.filter((i) => !fix.includes(i));
    }
  }
  return size;
}

function layoutGrid(w: LWidget, spec: NonNullable<LWidget["grid"]>, node: LNode, shrink: Shrink | null) {
  const s = w.style;
  // Arranging after a measure: that measure's floors (see `sizeAxis`).
  const floors = !shrink && node.grid ? node.grid : null;
  const floorRows = floors?.floorRows ?? [];
  const floorCols = floors?.floorCols ?? [];
  const { x, y, w: ww, h: hh } = node.rect;
  const barW = s.scrollbar ? SCROLLBAR_W : 0;
  const contentW = bounded(ww) ? Math.max(0, ww - s.pad[1] - s.pad[3] - barW) : UNBOUNDED;
  const contentH = bounded(hh) ? Math.max(0, hh - s.pad[0] - s.pad[2]) : UNBOUNDED;
  const rows = spec.rows.length ? spec.rows.map(toTrack) : ONE_STAR;
  const cols = spec.cols.length ? spec.cols.map(toTrack) : ONE_STAR;
  const [rsp, csp] = [spec.rowSpacing, spec.colSpacing];

  // Each placed child's cells, clamped to the grid (like WPF): [r0, r1, c0, c1].
  const spans = w.children.map((c): [number, number, number, number] | null => {
    if (!c.visible || c.style.pos !== null) return null;
    const [row, col, rs, cs] = c.style.cell;
    const r0 = Math.min(row, rows.length - 1);
    const c0 = Math.min(col, cols.length - 1);
    return [r0, Math.min(r0 + Math.max(1, rs), rows.length), c0, Math.min(c0 + Math.max(1, cs), cols.length)];
  });
  const sizesAuto = (tracks: Track[], avail: number, a: number, b: number) => {
    const flex = bounded(avail);
    const span = tracks.slice(a, b);
    return span.some((t) => autoLike(t, flex)) && !span.some((t) => isStar(t, flex));
  };

  // Columns: children measured for width only.
  const colItems: [number, number, number][] = [];
  w.children.forEach((c, i) => {
    const sp = spans[i];
    if (!sp || !sizesAuto(cols, contentW, sp[2], sp[3])) return;
    const m = c.style.margin;
    const capH = less(measureCap(rows, rsp, contentH, sp[0], sp[1]), m[0] + m[2]);
    const tmp = newNode(c);
    layoutWidget(c, tmp, 0, 0, UNBOUNDED, capH, UNBOUNDED, UNBOUNDED);
    colItems.push([sp[2], sp[3], tmp.rect.w + m[1] + m[3]]);
  });
  const colSize = sizeAxis(cols, contentW, csp, colItems, floorCols);

  // Rows: children measured at their final column widths.
  const rowItems: [number, number, number][] = [];
  w.children.forEach((c, i) => {
    const sp = spans[i];
    if (!sp || !sizesAuto(rows, contentH, sp[0], sp[1])) return;
    const m = c.style.margin;
    const cellW = less(extentOf(colSize, csp, sp[2], sp[3]), m[1] + m[3]);
    const tmp = newNode(c);
    layoutWidget(c, tmp, 0, 0, cellW, UNBOUNDED, cellW, UNBOUNDED);
    rowItems.push([sp[0], sp[1], tmp.rect.h + m[0] + m[2]]);
  });
  const rowSize = sizeAxis(rows, contentH, rsp, rowItems, floorRows);

  const totalW = extentOf(colSize, csp, 0, cols.length);
  const totalH = extentOf(rowSize, rsp, 0, rows.length);
  if (shrink) {
    if (shrink.w) node.rect.w = Math.min(Math.max(totalW + s.pad[1] + s.pad[3] + barW, s.minW), shrink.maxW);
    if (shrink.h) node.rect.h = Math.min(Math.max(totalH + s.pad[0] + s.pad[2], s.minH), shrink.maxH);
  }
  const starts = (sizes: number[], spacing: number, origin: number) => {
    let at = origin;
    return sizes.map((v) => {
      const p = at;
      at += v + spacing;
      return p;
    });
  };
  const colX = starts(colSize, csp, x + s.pad[3]);
  const rowY = starts(rowSize, rsp, y + s.pad[0]);
  node.grid = {
    rows: rowY.map((p, i) => [p, rowSize[i]]),
    cols: colX.map((p, i) => [p, colSize[i]]),
    floorRows: bounded(contentH) ? floorRows : [...rowSize],
    floorCols: bounded(contentW) ? floorCols : [...colSize],
  };

  const childNodes = w.children.map((c, i) => {
    const cn = newNode(c);
    const m = c.style.margin;
    const sp = spans[i];
    if (!sp) {
      if (!c.visible) cn.rect = { x: x + s.pad[3], y: y + s.pad[0], w: 0, h: 0 };
      else if (c.style.pos) {
        // Positioned: as in a panel, inside the content box.
        const [px, py] = c.style.pos;
        const mw = less(bounded(contentW) ? contentW : totalW, px + m[1] + m[3]);
        const mh = less(bounded(contentH) ? contentH : totalH, py + m[0] + m[2]);
        layoutWidget(c, cn, 0, 0, mw, mh, contentW, contentH);
        arrange(c, cn, x + s.pad[3] + px + m[3], y + s.pad[0] + py + m[0]);
      }
      return cn;
    }
    const innerW = Math.max(0, extentOf(colSize, csp, sp[2], sp[3]) - m[1] - m[3]);
    const innerH = Math.max(0, extentOf(rowSize, rsp, sp[0], sp[1]) - m[0] - m[2]);
    const halign = c.style.halign ?? "stretch";
    if (halign === "stretch") layoutWidget(c, cn, 0, 0, innerW, innerH, innerW, innerH);
    else measureAligned(c, cn, innerW, innerH, innerW, innerH);
    const valign = c.style.valign ?? "stretch";
    // Stretch fills the cell unless the size is explicit — then it's centred, like WPF.
    let fx: number;
    if (halign === "stretch" && c.style.w.t === "auto") {
      cn.rect.w = innerW;
      fx = 0;
    } else fx = halign === "left" ? 0 : halign === "right" ? 1 : 0.5;
    let fy: number;
    if (valign === "stretch" && c.style.h.t === "auto") {
      cn.rect.h = innerH;
      fy = 0;
    } else fy = valign === "top" ? 0 : valign === "bottom" ? 1 : 0.5;
    cn.rect.w = Math.min(cn.rect.w, innerW);
    cn.rect.h = Math.min(cn.rect.h, innerH);
    arrange(c, cn, colX[sp[2]] + m[3] + (innerW - cn.rect.w) * fx, rowY[sp[0]] + m[0] + (innerH - cn.rect.h) * fy);
    return cn;
  });
  node.children = childNodes;
}
