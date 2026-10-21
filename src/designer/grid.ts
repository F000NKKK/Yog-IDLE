// `<Grid>` definitions in `.yui` (docs/yui.md, "Grid"): rows and columns
// either compact (`rows="Auto,*,26"`) or as WPF property elements
// (`<Grid.RowDefinitions><RowDefinition height="Auto" min_height="10"/>`).
// Read leniently (the canvas draws while the XAML is being typed) and
// written back in the form the file already uses.

import { yui, yuiAttr } from "../data/yogIds.generated";
import { formatNumber, newUid, parseNumber, type YuiNode } from "./yui";

/** A row height / column width — WPF's `GridLength`. */
export type GridLength = { t: "auto" } | { t: "px"; v: number } | { t: "star"; v: number };

/** One `RowDefinition` / `ColumnDefinition`. */
export interface TrackDef {
  size: GridLength;
  min: number | null;
  max: number | null;
}

export type Axis = "rows" | "cols";

export const AXES: Record<Axis, { attr: string; prop: string; def: string; size: string; min: string; max: string; cell: string; span: string }> = {
  rows: { attr: yuiAttr.ROWS, prop: yui.ROW_DEFINITIONS, def: yui.ROW_DEFINITION, size: yuiAttr.HEIGHT, min: yuiAttr.MIN_HEIGHT, max: yuiAttr.MAX_HEIGHT, cell: yuiAttr.GRID_ROW, span: yuiAttr.GRID_ROWSPAN },
  cols: { attr: yuiAttr.COLUMNS, prop: yui.COLUMN_DEFINITIONS, def: yui.COLUMN_DEFINITION, size: yuiAttr.WIDTH, min: yuiAttr.MIN_WIDTH, max: yuiAttr.MAX_WIDTH, cell: yuiAttr.GRID_COLUMN, span: yuiAttr.GRID_COLUMNSPAN },
};

/** `Auto`, `*`, `2*`, `26` — `null` if it's none of them. */
export function parseLength(text: string): GridLength | null {
  const v = text.trim();
  if (v.toLowerCase() === "auto") return { t: "auto" };
  if (v.endsWith("*")) {
    const w = v.slice(0, -1).trim();
    const n = w === "" ? 1 : parseNumber(w);
    return n === null || n < 0 ? null : { t: "star", v: n };
  }
  const n = parseNumber(v);
  return n === null || n < 0 ? null : { t: "px", v: n };
}

export function formatLength(l: GridLength): string {
  if (l.t === "auto") return "Auto";
  if (l.t === "star") return l.v === 1 ? "*" : `${formatNumber(l.v)}*`;
  return formatNumber(l.v);
}

const STAR: GridLength = { t: "star", v: 1 };

/** A Grid's rows and columns as written (unreadable sizes count as `*`). */
export function gridDefs(node: YuiNode): { rows: TrackDef[]; cols: TrackDef[] } {
  const read = (axis: Axis): TrackDef[] => {
    const a = AXES[axis];
    const compact = node.attrs[a.attr];
    if (compact !== undefined) return compact.split(",").map((p) => ({ size: parseLength(p) ?? STAR, min: null, max: null }));
    const prop = node.children.find((c) => c.kind === a.prop);
    return (prop?.children ?? [])
      .filter((d) => d.kind === a.def)
      .map((d) => ({ size: parseLength(d.attrs[a.size] ?? "*") ?? STAR, min: parseNumber(d.attrs[a.min]), max: parseNumber(d.attrs[a.max]) }));
  };
  return { rows: read("rows"), cols: read("cols") };
}

/**
 * `grid` with its rows (columns) set to `defs`: kept in the `<Grid.RowDefinitions>`
 * form when the file uses it or a limit needs it, else as `rows="..."`; none at all
 * removes both (one `*` row, like WPF).
 */
export function withGridDefs(grid: YuiNode, axis: Axis, defs: TrackDef[]): YuiNode {
  const a = AXES[axis];
  const attrs = { ...grid.attrs };
  delete attrs[a.attr];
  const at = grid.children.findIndex((c) => c.kind === a.prop);
  const children = grid.children.filter((c) => c.kind !== a.prop);
  const limits = defs.some((d) => d.min !== null || d.max !== null);
  if (defs.length > 0 && (at >= 0 || limits)) {
    const old = at >= 0 ? grid.children[at] : null;
    const prop: YuiNode = {
      uid: old?.uid ?? newUid(),
      kind: a.prop,
      attrs: {},
      children: defs.map((d, i) => {
        const da: Record<string, string> = {};
        if (!(d.size.t === "star" && d.size.v === 1)) da[a.size] = formatLength(d.size);
        if (d.min !== null) da[a.min] = formatNumber(d.min);
        if (d.max !== null) da[a.max] = formatNumber(d.max);
        return { uid: old?.children[i]?.uid ?? newUid(), kind: a.def, attrs: da, children: [] };
      }),
    };
    // Row definitions first, then column definitions, then the widgets — as WPF writes them.
    const before = children.filter((c) => c.kind === AXES.rows.prop && axis === "cols").length;
    children.splice(before, 0, prop);
  } else if (defs.length > 0) {
    attrs[a.attr] = defs.map((d) => formatLength(d.size)).join(",");
  }
  return { ...grid, attrs, children };
}

/** Where a Grid's child sits: row, column, row span, column span (defaults 0, 0, 1, 1). */
export function cellOf(node: YuiNode): { row: number; col: number; rowSpan: number; colSpan: number } {
  const n = (k: string, min: number, fallback: number) => {
    const v = parseNumber(node.attrs[k]);
    return v === null || v < min ? fallback : Math.floor(v);
  };
  return { row: n(yuiAttr.GRID_ROW, 0, 0), col: n(yuiAttr.GRID_COLUMN, 0, 0), rowSpan: n(yuiAttr.GRID_ROWSPAN, 1, 1), colSpan: n(yuiAttr.GRID_COLUMNSPAN, 1, 1) };
}

/** The attribute changes that put a child in `row`, `col` (defaults removed). */
export function cellAttrs(row: number, col: number): Record<string, string | undefined> {
  return { [yuiAttr.GRID_ROW]: row > 0 ? String(row) : undefined, [yuiAttr.GRID_COLUMN]: col > 0 ? String(col) : undefined };
}

/**
 * The children's `Grid.Row`/`Grid.RowSpan` (or column) after track `index` is
 * inserted (`delta` 1) or removed (`delta` -1) — like Visual Studio, children
 * keep their place and spans across it grow or shrink. `count`: the tracks
 * there are after the change (nothing is left past the last one; `delta` 0
 * only does that).
 */
export function shiftCells(grid: YuiNode, axis: Axis, index: number, delta: 1 | 0 | -1, count: number): YuiNode {
  const a = AXES[axis];
  const children = grid.children.map((c) => {
    if (c.kind.includes(".")) return c;
    const cell = cellOf(c);
    let start = axis === "rows" ? cell.row : cell.col;
    let span = axis === "rows" ? cell.rowSpan : cell.colSpan;
    const end = start + span;
    if (delta === 1) {
      if (start >= index) start += 1;
      else if (end > index) span += 1;
    } else if (delta === 0) {
      // Only clamped.
    } else if (start > index) start -= 1;
    else if (end > index && span > 1) span -= 1;
    const last = Math.max(1, count) - 1;
    start = Math.min(start, last);
    span = Math.max(1, Math.min(span, last + 1 - start));
    const attrs = { ...c.attrs };
    if (start > 0) attrs[a.cell] = String(start);
    else delete attrs[a.cell];
    if (span > 1) attrs[a.span] = String(span);
    else delete attrs[a.span];
    return { ...c, attrs };
  });
  return { ...grid, children };
}
