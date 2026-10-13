// A line-for-line port of yog-ui's layout (`layout.rs`) and text metrics
// (`text.rs`), so the designer places every widget exactly where the game
// will. Keep in step with the crate.

import { CANVAS_KINDS, parseColor, parseNumber, type YuiNode } from "./yui";

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

export function wrapText(text: string, maxW: number, scale: number): string[] {
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
export const SCROLLBAR_W = 6;

function textHeight(text: string, maxW: number, scale: number): number {
  const n = Math.max(1, wrapText(text, maxW, scale).length);
  return n * LINE_H * scale + Math.max(0, n - 1) * LINE_GAP;
}

// ── Widget model (mirrors `widget.rs`) ───────────────────────────────────────

export type Units = { t: "auto" } | { t: "px"; v: number } | { t: "pct"; v: number };
export type Dock = "none" | "fill" | "left" | "right" | "top" | "bottom";
export type Align = "start" | "center" | "end";
export type Leaf = "panel" | "label" | "button" | "item_slot" | "inv_slot" | "image" | "spacer";

export interface Style {
  w: Units;
  h: Units;
  minW: number;
  minH: number;
  flex: number;
  dock: Dock;
  gap: number;
  pad: [number, number, number, number];
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
  /** Clips its children (ScrollView); a growing clip container starts from its min size. */
  clip: boolean;
  pos: [number, number] | null;
}

export interface LWidget {
  /** The `.yui` node this came from (`""` for the screen-sized wrapper). */
  uid: string;
  kind: Leaf;
  dir: "row" | "column";
  text: string;
  item: string;
  count: number;
  texture: string;
  texW: number;
  texH: number;
  style: Style;
  children: LWidget[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LNode {
  uid: string;
  rect: Rect;
  children: LNode[];
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

const LEAF_OF: Record<string, Leaf> = {
  Screen: "panel",
  Canvas: "panel",
  Column: "panel",
  Row: "panel",
  ScrollView: "panel",
  Label: "label",
  Button: "button",
  ItemSlot: "item_slot",
  InvSlot: "inv_slot",
  Image: "image",
  Spacer: "spacer",
};

/** The widget a `.yui` node becomes — what its generated builder code would build. Lenient: a bad value falls back to the default. */
export function toWidget(node: YuiNode, inCanvas: boolean): LWidget {
  const a = node.attrs;
  const kind = LEAF_OF[node.kind] ?? "spacer";
  const style = defaultStyle();
  const texW = parseNumber(a.tex_w) ?? 16;
  const texH = parseNumber(a.tex_h) ?? 16;
  // Constructors that set a size (`inv_slot`, `mc_image`).
  if (kind === "inv_slot") {
    style.w = { t: "px", v: 18 };
    style.h = { t: "px", v: 18 };
  } else if (kind === "image") {
    style.w = texW > 0 ? { t: "px", v: texW } : { t: "auto" };
    style.h = texH > 0 ? { t: "px", v: texH } : { t: "auto" };
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
  style.bg = parseColor(a.bg) ?? style.bg;
  style.color = parseColor(a.color) ?? style.color;
  if (a.shadow === "false") style.shadow = false;
  if (a.no_wrap === "true") style.noWrap = true;
  if (a.ellipsis === "true") style.noWrap = style.ellipsis = true;
  if (node.kind === "ScrollView") style.scrollbar = style.clip = true;
  const canvas = CANVAS_KINDS.has(node.kind);
  return {
    uid: node.uid,
    kind,
    dir: node.kind === "Row" ? "row" : "column",
    text: a.text ?? "",
    item: a.item ?? "",
    count: Math.max(0, Math.floor(parseNumber(a.count) ?? 1)),
    texture: a.texture ?? "",
    texW,
    texH,
    style,
    children: LEAF_OF[node.kind] === "panel" ? node.children.map((c) => toWidget(c, canvas)) : [],
  };
}

/** Where the generated `root_with` puts the screen inside a `screenW` × `screenH` GUI. */
export function anchorOffset(anchor: string | undefined, screenW: number, screenH: number, w: number, h: number): [number, number] {
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

// ── Layout (mirrors `layout.rs`) ─────────────────────────────────────────────
//
// Percent sizes resolve once, against the parent's content box; along an
// axis still being measured for content (unbounded) they act as `auto`.
// Grown (flex) sizes stick: children are re-laid against the final size.

export function compute(w: LWidget, availW: number, availH: number): LNode {
  const node: LNode = { uid: w.uid, rect: { x: 0, y: 0, w: 0, h: 0 }, children: [] };
  layoutWidget(w, node, 0, 0, availW, availH, availW, availH);
  return node;
}

/** "No size cap: measure to content" (`layout::UNBOUNDED`). */
const UNBOUNDED = F32_MAX;
const bounded = (v: number) => v < UNBOUNDED / 2;

function resolveSize(u: Units, basis: number): number | null {
  if (u.t === "pct" && !bounded(basis)) return null;
  return resolve(u, basis);
}

interface Shrink {
  w: boolean;
  h: boolean;
  maxW: number;
  maxH: number;
}

function layoutWidget(w: LWidget, node: LNode, x: number, y: number, maxW: number, maxH: number, basisW: number, basisH: number) {
  const s = w.style;
  const hasChildren = w.children.length > 0;
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
        ww = Math.min(Math.max(w.texW + s.pad[1] + s.pad[3], s.minW), maxW);
        hh = Math.min(Math.max(w.texH + s.pad[0] + s.pad[2], s.minH), maxH);
        break;
    }
    if (explicitW !== null) ww = explicitW;
    if (explicitH !== null) hh = explicitH;
  }

  node.rect = { x, y, w: ww, h: hh };
  if (hasChildren) layoutChildren(w, node, { w: explicitW === null, h: explicitH === null, maxW, maxH });
}

/** Final rect for an already measured widget; children lay out against it. */
function arrange(w: LWidget, node: LNode, x: number, y: number) {
  node.rect.x = x;
  node.rect.y = y;
  if (w.children.length > 0) layoutChildren(w, node, null);
}

function layoutChildren(w: LWidget, node: LNode, shrink: Shrink | null) {
  const s = w.style;
  const { x, y, w: ww, h: hh } = node.rect;
  const dir = w.kind === "panel" && w.dir === "row" ? "row" : "column";
  const barW = s.scrollbar ? SCROLLBAR_W : 0;
  const contentW = bounded(ww) ? Math.max(0, ww - s.pad[1] - s.pad[3] - barW) : UNBOUNDED;
  const contentH = bounded(hh) ? Math.max(0, hh - s.pad[0] - s.pad[2]) : UNBOUNDED;
  const mainBounded = bounded(dir === "row" ? contentW : contentH);
  const crossBounded = bounded(dir === "row" ? contentH : contentW);
  const crossOffset = (content: number, size: number) =>
    !crossBounded ? 0 : s.align === "center" ? (content - size) / 2 : s.align === "end" ? content - size : 0;
  const effectiveFlex = (c: LWidget) => (c.style.dock === "fill" ? Math.max(c.style.flex, 1) : c.style.flex);
  const inFlow = (c: LWidget) => c.style.pos === null && !((dir === "row" && c.style.dock === "right") || (dir === "column" && c.style.dock === "bottom"));
  const stretches = (dock: Dock) =>
    crossBounded && (dir === "row" ? dock === "fill" || dock === "left" || dock === "right" : dock === "fill" || dock === "top" || dock === "bottom");

  const childNodes: LNode[] = [];
  let totalFlex = 0;
  let usedMain = 0;
  for (const child of w.children) {
    const cn: LNode = { uid: child.uid, rect: { x: 0, y: 0, w: 0, h: 0 }, children: [] };
    if (child.style.pos) {
      const [px, py] = child.style.pos;
      const mw = bounded(contentW) ? Math.max(0, contentW - px) : UNBOUNDED;
      const mh = bounded(contentH) ? Math.max(0, contentH - py) : UNBOUNDED;
      layoutWidget(child, cn, 0, 0, mw, mh, contentW, contentH);
      childNodes.push(cn);
      continue;
    }
    let cmw: number;
    let cmh: number;
    if (child.style.dock === "fill") [cmw, cmh] = [contentW, contentH];
    else if (dir === "row") [cmw, cmh] = [UNBOUNDED, contentH];
    else [cmw, cmh] = [contentW, UNBOUNDED];
    layoutWidget(child, cn, 0, 0, cmw, cmh, contentW, contentH);
    const ef = effectiveFlex(child);
    if (ef > 0 && child.style.clip && mainBounded && inFlow(child)) {
      if (dir === "row" && child.style.w.t === "auto") cn.rect.w = child.style.minW;
      if (dir === "column" && child.style.h.t === "auto") cn.rect.h = child.style.minH;
    }
    usedMain += dir === "row" ? cn.rect.w : cn.rect.h;
    if (inFlow(child)) totalFlex += ef;
    childNodes.push(cn);
  }
  const placed = w.children.filter((c) => c.style.pos === null).length;
  usedMain += s.gap * Math.max(0, placed - 1);
  const available = mainBounded ? (dir === "row" ? contentW : contentH) - usedMain : 0;
  let pos = dir === "row" ? s.pad[3] : s.pad[0];

  w.children.forEach((child, i) => {
    if (!inFlow(child)) return;
    const cn = childNodes[i];
    const ef = effectiveFlex(child);
    const grow = ef > 0 && totalFlex > 0 && available > 0 ? (available * ef) / totalFlex : 0;
    const stretch = stretches(child.style.dock);
    let cx: number;
    let cy: number;
    if (dir === "row") {
      cn.rect.w += grow;
      if (stretch) cn.rect.h = contentH;
      cx = x + pos;
      cy = y + s.pad[0] + crossOffset(contentH, cn.rect.h);
      pos += cn.rect.w + s.gap;
    } else {
      cn.rect.h += grow;
      if (stretch) cn.rect.w = contentW;
      cx = x + s.pad[3] + crossOffset(contentW, cn.rect.w);
      cy = y + pos;
      pos += cn.rect.h + s.gap;
    }
    arrange(child, cn, cx, cy);
  });

  let rpos: number;
  if (mainBounded) rpos = dir === "row" ? x + s.pad[3] + contentW : y + s.pad[0] + contentH;
  else {
    const docked = w.children.map((c, i) => [c, childNodes[i]] as const).filter(([c]) => !inFlow(c) && c.style.pos === null);
    const span = docked.reduce((sum, [, n]) => sum + (dir === "row" ? n.rect.w : n.rect.h), 0) + s.gap * Math.max(0, docked.length - 1);
    rpos = (dir === "row" ? x : y) + pos + span;
  }
  w.children.forEach((child, i) => {
    if (inFlow(child) || child.style.pos) return;
    const cn = childNodes[i];
    const stretch = stretches(child.style.dock);
    let cx: number;
    let cy: number;
    if (dir === "row") {
      if (stretch) cn.rect.h = contentH;
      rpos -= cn.rect.w;
      cx = rpos;
      cy = y + s.pad[0] + crossOffset(contentH, cn.rect.h);
    } else {
      if (stretch) cn.rect.w = contentW;
      rpos -= cn.rect.h;
      cx = x + s.pad[3] + crossOffset(contentW, cn.rect.w);
      cy = rpos;
    }
    rpos -= s.gap;
    arrange(child, cn, cx, cy);
  });

  w.children.forEach((child, i) => {
    if (!child.style.pos) return;
    arrange(child, childNodes[i], x + s.pad[3] + child.style.pos[0], y + s.pad[0] + child.style.pos[1]);
  });

  if (shrink) {
    if (shrink.w) {
      const cw = childNodes.reduce((m, c) => Math.max(m, c.rect.x - x + c.rect.w), 0);
      node.rect.w = Math.min(Math.max(cw + s.pad[1] + barW, s.minW), shrink.maxW);
    }
    if (shrink.h) {
      const ch = childNodes.reduce((m, c) => Math.max(m, c.rect.y - y + c.rect.h), 0);
      node.rect.h = Math.min(Math.max(ch + s.pad[2], s.minH), shrink.maxH);
    }
  }
  node.children = childNodes;
}
