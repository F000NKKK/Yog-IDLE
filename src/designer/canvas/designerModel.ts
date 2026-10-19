// The screen designer's model side: zooms, the edit session, view settings,
// the real picture's geometry, events, and the helpers over the .yui tree.

import { type DesignRect, stemOf } from "substrate-platform-ui";
import { yui } from "../../data/yogIds.generated";
import { cellAttrs, cellOf, gridDefs } from "../grid";
import type { LNode, LWidget } from "../layoutWidget";
import { formatNumber, isCanvas, isGrid, pathOf, withAttrs, type YuiDoc, type YuiNode } from "../yui";

/** Common GUI sizes — the game window divided by its GUI scale. */
export const RESOLUTIONS: { w: number; h: number; label: string }[] = [
  { w: 480, h: 270, label: "480 × 270 (1920 × 1080, GUI 4)" },
  { w: 640, h: 360, label: "640 × 360 (1920 × 1080, GUI 3)" },
  { w: 960, h: 540, label: "960 × 540 (1920 × 1080, GUI 2)" },
  { w: 427, h: 240, label: "427 × 240 (854 × 480, GUI 2)" },
  { w: 320, h: 240, label: "320 × 240 (minimum window)" },
];

export const ZOOMS = [1, 2, 3, 4, 5, 6, 8];
export const GRID = 2;

export interface Session {
  text: string;
  doc: YuiDoc;
  selection: string[];
  /** The selection that went with each text the designer wrote or left — restored when Undo/Redo (the XAML's CodeMirror history, or the platform's) brings that text back. */
  selectionByText: Map<string, number[][]>;
}

/** Remembers `selection` (as child-index paths) for `text`, keeping the map small. */
export function rememberSelection(s: Session, text: string, doc: YuiDoc, selection: string[]) {
  s.selectionByText.delete(text);
  s.selectionByText.set(
    text,
    selection.map((uid) => pathOf(doc.root, uid)).filter((p): p is number[] => !!p)
  );
  while (s.selectionByText.size > 400) s.selectionByText.delete(s.selectionByText.keys().next().value!);
}

export interface ViewSettings {
  res: number;
  zoom: number;
  snap: boolean;
  showGrid: boolean;
}

// Kept per file while the IDE runs: switching to the XAML view and back
// unmounts the designer, but its undo history survives if the text is what
// it left. (In the split view the XAML editor keeps the history instead.)
export const sessions = new Map<string, Session>();
export let settings: ViewSettings = { res: 0, zoom: 2, snap: true, showGrid: false };

/** Remembers the view settings for the next designer opened. */
export function setSettings(next: ViewSettings): void {
  settings = next;
}
export let clipboard: string | null = null;

/** What Copy put on the designer's clipboard. */
export function setClipboard(next: string | null): void {
  clipboard = next;
}

/** One widget's laid-out geometry. */
export interface Geo {
  rect: DesignRect;
  content: DesignRect;
  /** A grid's rows and columns: `[start, size]`. */
  grid?: { rows: [number, number][]; cols: [number, number][] };
}

/** What `yui_designer_render` answers (`src-tauri/src/designer`). */
export interface RenderReply {
  image: string;
  scale: number;
  rects: { uid: string; rect: [number, number, number, number]; content: [number, number, number, number]; grid?: { rows: [number, number][]; cols: [number, number][] } }[];
  assets: { version: string; jar: string } | null;
  realFont: boolean;
}

/** A picture drawn by yog-ui itself (the code the game runs), for `root` at `w × h`. */
export interface Rendered {
  root: YuiNode;
  w: number;
  h: number;
  image: string;
  geo: Map<string, Geo>;
  assets: RenderReply["assets"];
  realFont: boolean;
}

export interface EventReply {
  scrolled: boolean;
  hit: string | null;
  clicked: string | null;
}

export interface HandlerLocation {
  path: string;
  line: number;
  column: number;
  changed: boolean;
}

export const toRect = ([x, y, w, h]: [number, number, number, number]): DesignRect => ({ x, y, w, h });

/** The event a double-click on `node` opens the handler of (Visual Studio's default event), if it has one. */
export function defaultEvent(node: YuiNode): "on_click" | "on_change" | null {
  if (node.kind === yui.BUTTON) return "on_click";
  if (node.kind === yui.TEXT_BOX) return "on_change";
  return node.kind !== yui.SCREEN && node.attrs.on_click ? "on_click" : null;
}

/** A new event name for `attr` on `node`, like Visual Studio's `button1_Click`: `<id>_click`, unique in the screen. */
export function newEventName(root: YuiNode, node: YuiNode, attr: string): string {
  const suffix = attr.replace(/^on_/, "");
  const used = new Set<string>();
  const visit = (n: YuiNode) => {
    for (const [k, v] of Object.entries(n.attrs)) if (k.startsWith("on_")) used.add(v);
    n.children.forEach(visit);
  };
  visit(root);
  const base = (node.attrs.id ?? node.kind).replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1").toLowerCase();
  if (node.attrs.id && !used.has(`${base}_${suffix}`)) return `${base}_${suffix}`;
  for (let i = 1; ; i++) if (!used.has(`${base}${i}_${suffix}`)) return `${base}${i}_${suffix}`;
}

export function collect(widget: LWidget, node: LNode, out: Map<string, Geo>) {
  const p = widget.style.pad;
  const r = node.rect;
  out.set(widget.uid, {
    rect: r,
    content: { x: r.x + p[3], y: r.y + p[0], w: Math.max(0, r.w - p[1] - p[3]), h: Math.max(0, r.h - p[0] - p[2]) },
    grid: node.grid && { rows: node.grid.rows, cols: node.grid.cols },
  });
  widget.children.forEach((c, i) => node.children[i] && collect(c, node.children[i], out));
}

/** `n` without the `Grid.*` attached properties when `parent` isn't a Grid (they'd be an error there). */
export const fitParent = (n: YuiNode, parent: YuiNode) =>
  isGrid(parent) || !Object.keys(n.attrs).some((k) => k.startsWith("Grid.")) ? n : withAttrs(n, { "Grid.Row": undefined, "Grid.Column": undefined, "Grid.RowSpan": undefined, "Grid.ColumnSpan": undefined });

/** Spans that would run past a grid's last row/column shortened (after a move into it). */
export function clampCells(grid: YuiNode): YuiNode {
  const defs = gridDefs(grid);
  const fit = (n: YuiNode) => {
    const c = cellOf(n);
    const rows = Math.max(1, defs.rows.length);
    const cols = Math.max(1, defs.cols.length);
    const row = Math.min(c.row, rows - 1);
    const col = Math.min(c.col, cols - 1);
    const rs = Math.min(c.rowSpan, rows - row);
    const cs = Math.min(c.colSpan, cols - col);
    if (row === c.row && col === c.col && rs === c.rowSpan && cs === c.colSpan) return n;
    return withAttrs(n, { ...cellAttrs(row, col), "Grid.RowSpan": rs > 1 ? String(rs) : undefined, "Grid.ColumnSpan": cs > 1 ? String(cs) : undefined });
  };
  const children = grid.children.map((c) => (c.kind.includes(".") ? c : fit(c)));
  return children.every((c, i) => c === grid.children[i]) ? grid : { ...grid, children };
}

export const positioned = (n: YuiNode, parent: YuiNode | null) => !!parent && (isCanvas(parent) || n.attrs.x !== undefined || n.attrs.y !== undefined);
export const round = (v: number) => formatNumber(Math.round(v));

/** The screen's name as an identifier (`Main Menu.yui` → `main_menu`). */
export function screenIdOf(path: string): string {
  return stemOf(path).replace(/[^a-z0-9_]/gi, "_").toLowerCase() || "screen";
}

export function nodeLabel(n: YuiNode): string {
  const name = n.attrs.id ? `${n.attrs.id} ` : "";
  return `${name}(${n.kind})`;
}
