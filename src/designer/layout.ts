// A line-for-line port of yog-ui's layout (`layout.rs`, `layout/grid.rs`), so
// the designer places every widget exactly where the game will. Keep in step
// with the crate.

import { type GridLength, type TrackDef } from "./grid";
import { type Align, type LNode, type LWidget, resolve, type Units } from "./layoutWidget";
import { F32_MAX, LINE_H, SCROLLBAR_W, strWidth, textHeight } from "./layoutText";

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
