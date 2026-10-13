// Visual Studio's Grid adorners on the design surface: dashed lines between
// every grid's rows and columns, and — for the selected grid (or the grid of
// the selected widget) — rails above and left of it with each row's and
// column's size. Click a rail to add a line there, drag a line's grip to
// resize, right-click a size to make it Auto, * or pixels.

import { useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { showDialog, t, useT, type ContextMenuItem, type DesignRect } from "substrate-platform-ui";
import { AXES, formatLength, gridDefs, parseLength, shiftCells, withGridDefs, type Axis, type GridLength, type TrackDef } from "./grid";
import { formatNumber, parseNumber, type YuiNode } from "./yui";

/** A laid-out grid: its box, content box and rows/columns (`[start, size]`, GUI px). */
export interface GridGeo {
  rect: DesignRect;
  content: DesignRect;
  rows: [number, number][];
  cols: [number, number][];
}

/** Rail thickness and its distance from the grid, in screen px. */
const RAIL = 14;
const RAIL_GAP = 3;
const STAR: TrackDef = { size: { t: "star", v: 1 }, min: null, max: null };

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Where track `i` ends and `i + 1` begins (the middle of the spacing between them). */
function boundary(lines: [number, number][], i: number): number {
  const [s0, z0] = lines[i - 1];
  return (s0 + z0 + lines[i][0]) / 2;
}

/** The definitions as the rails show them — an undefined axis is one `*` track. */
function shownDefs(grid: YuiNode, axis: Axis): TrackDef[] {
  const defs = gridDefs(grid)[axis];
  return defs.length > 0 ? defs : [STAR];
}

/** The track at `at` (GUI px along the axis). */
function trackAt(lines: [number, number][], at: number): number {
  let i = 0;
  while (i + 1 < lines.length && at >= boundary(lines, i + 1)) i++;
  return i;
}

/** The grid cell at a point — what a widget dropped there gets as Grid.Row / Grid.Column. */
export function cellAt(geo: GridGeo, x: number, y: number): [number, number] {
  return [trackAt(geo.rows, y), trackAt(geo.cols, x)];
}

/** Splits track `i` at `at` (GUI px) into two, keeping the total — a click on the rail. */
export function splitTrack(grid: YuiNode, axis: Axis, lines: [number, number][], at: number): YuiNode {
  const defs = shownDefs(grid, axis);
  const i = trackAt(lines, at);
  const [start, size] = lines[i];
  const first = Math.round(at - start);
  const second = Math.round(size) - first;
  if (first < 1 || second < 1) return grid;
  const d = defs[i];
  const part = (px: number, keepLimits: boolean): TrackDef => {
    const limits = keepLimits ? { min: d.min, max: d.max } : { min: null, max: null };
    if (d.size.t === "star") return { size: { t: "star", v: Math.max(0.01, round2((d.size.v * px) / size)) }, ...limits };
    return { size: { t: "px", v: px }, ...limits };
  };
  const next = [...defs.slice(0, i), part(first, true), part(second, false), ...defs.slice(i + 1)];
  return shiftCells(withGridDefs(grid, axis, next), axis, i + 1, 1, next.length);
}

/** Moves the line between tracks `i - 1` and `i` by `delta` GUI px — the two keep their total; `*` stays `*` (reweighted), the others become pixels. */
export function resizeTracks(grid: YuiNode, axis: Axis, lines: [number, number][], i: number, delta: number): YuiNode {
  const defs = shownDefs(grid, axis);
  const a = lines[i - 1][1];
  const b = lines[i][1];
  const d = Math.max(-a, Math.min(b, delta));
  let weight = 0;
  let starPx = 0;
  defs.forEach((def, k) => {
    if (def.size.t === "star") {
      weight += def.size.v;
      starPx += lines[k][1];
    }
  });
  const perPx = starPx > 0 ? weight / starPx : 0;
  const sized = (def: TrackDef, px: number): TrackDef =>
    def.size.t === "star" && perPx > 0 ? { ...def, size: { t: "star", v: round2(px * perPx) } } : { ...def, size: { t: "px", v: Math.round(px) } };
  const next = [...defs];
  next[i - 1] = sized(defs[i - 1], a + d);
  next[i] = sized(defs[i], b - d);
  return withGridDefs(grid, axis, next);
}

/** Track `i` made `size` (the right-click menu). */
function retype(grid: YuiNode, axis: Axis, i: number, size: GridLength): YuiNode {
  const next = [...shownDefs(grid, axis)];
  next[i] = { ...next[i], size };
  return withGridDefs(grid, axis, next);
}

function insertTrack(grid: YuiNode, axis: Axis, i: number): YuiNode {
  const defs = shownDefs(grid, axis);
  const next = [...defs.slice(0, i), STAR, ...defs.slice(i)];
  return shiftCells(withGridDefs(grid, axis, next), axis, i, 1, next.length);
}

function deleteTrack(grid: YuiNode, axis: Axis, i: number): YuiNode {
  const defs = shownDefs(grid, axis);
  const next = defs.filter((_, k) => k !== i);
  return shiftCells(withGridDefs(grid, axis, next), axis, i, -1, Math.max(1, next.length));
}

/** Dashed lines between the rows and columns of every grid — designer only, like Visual Studio's. */
export function GridLines({ grids, zoom }: { grids: GridGeo[]; zoom: number }) {
  const out: ReactNode[] = [];
  grids.forEach((g, n) => {
    const c = g.content;
    for (let i = 1; i < g.cols.length; i++)
      out.push(<div key={`${n}c${i}`} className="yui-grid-line yui-grid-line-v" style={{ left: boundary(g.cols, i) * zoom, top: c.y * zoom, height: c.h * zoom }} />);
    for (let i = 1; i < g.rows.length; i++)
      out.push(<div key={`${n}r${i}`} className="yui-grid-line yui-grid-line-h" style={{ left: c.x * zoom, top: boundary(g.rows, i) * zoom, width: c.w * zoom }} />);
  });
  return <>{out}</>;
}

type RailDrag = { axis: Axis; kind: "resize"; index: number; from: number; delta: number } | { axis: Axis; kind: "add"; at: number; from: number; moved: boolean };

export interface GridRailsProps {
  grid: YuiNode;
  geo: GridGeo;
  zoom: number;
  editable: boolean;
  /** Replaces the grid node (one undo step). */
  onChange: (next: YuiNode) => void;
  /** Opens a context menu at the pointer. */
  onMenu: (e: ReactMouseEvent, items: ContextMenuItem[]) => void;
}

/** The rails of one grid: sizes, add/resize/retype (see the module comment). */
export function GridRails({ grid, geo, zoom, editable, onChange, onMenu }: GridRailsProps) {
  const t = useT();
  const [drag, setDrag] = useState<RailDrag | null>(null);
  const [hover, setHover] = useState<{ axis: Axis; at: number } | null>(null);

  const rail = (axis: Axis) => {
    const lines = axis === "cols" ? geo.cols : geo.rows;
    const defs = shownDefs(grid, axis);
    const horizontal = axis === "cols";
    const c = geo.content;
    // The rail spans the content box; positions along it are GUI px.
    const origin = horizontal ? c.x : c.y;
    const length = horizontal ? c.w : c.h;
    const style = horizontal
      ? { left: c.x * zoom, top: geo.rect.y * zoom - RAIL - RAIL_GAP, width: length * zoom, height: RAIL }
      : { left: geo.rect.x * zoom - RAIL - RAIL_GAP, top: c.y * zoom, width: RAIL, height: length * zoom };
    const along = (e: { clientX: number; clientY: number }, el: Element) => {
      const r = el.getBoundingClientRect();
      return origin + (horizontal ? e.clientX - r.left : e.clientY - r.top) / zoom;
    };
    const what = horizontal ? t("column") : t("row");

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || !editable) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const grip = (e.target as HTMLElement).dataset.grip;
      const at = along(e, e.currentTarget);
      setDrag(grip ? { axis, kind: "resize", index: Number(grip), from: at, delta: 0 } : { axis, kind: "add", at, from: at, moved: false });
    };
    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
      const at = along(e, e.currentTarget);
      if (drag?.axis === axis) {
        if (drag.kind === "resize") setDrag({ ...drag, delta: Math.round(at - drag.from) });
        else setDrag({ ...drag, at, moved: drag.moved || Math.abs(at - drag.from) * zoom > 3 });
      } else setHover((e.target as HTMLElement).dataset.grip ? null : { axis, at });
    };
    const onPointerUp = () => {
      const d = drag;
      setDrag(null);
      if (!d || d.axis !== axis) return;
      if (d.kind === "resize" && d.delta !== 0) onChange(resizeTracks(grid, axis, lines, d.index, d.delta));
      if (d.kind === "add" && !d.moved) onChange(splitTrack(grid, axis, lines, d.at));
    };
    const menuFor = (e: ReactMouseEvent<HTMLDivElement>, i: number) => {
      e.preventDefault();
      const def = defs[i];
      const px = Math.max(1, Math.round(lines[i][1]));
      const disabled = !editable;
      onMenu(e, [
        { label: t("Auto"), checked: def.size.t === "auto", disabled, onSelect: () => onChange(retype(grid, axis, i, { t: "auto" })) },
        { label: t("Star (*)"), checked: def.size.t === "star", disabled, onSelect: () => onChange(retype(grid, axis, i, { t: "star", v: 1 })) },
        { label: t("Pixel ({px})", { px }), checked: def.size.t === "px", disabled, onSelect: () => onChange(retype(grid, axis, i, { t: "px", v: px })) },
        { label: t("Insert {what} Before", { what }), disabled, separatorBefore: true, onSelect: () => onChange(insertTrack(grid, axis, i)) },
        { label: t("Insert {what} After", { what }), disabled, onSelect: () => onChange(insertTrack(grid, axis, i + 1)) },
        { label: t("Delete {what}", { what }), disabled: disabled || defs.length < 2, destructive: true, onSelect: () => onChange(deleteTrack(grid, axis, i)) },
        { label: horizontal ? t("Edit Columns…") : t("Edit Rows…"), disabled, separatorBefore: true, onSelect: () => void editDefinitions(grid, axis).then((next) => next && onChange(next)) },
      ]);
    };

    const segments = lines.map(([start, size], i) => {
      const def = defs[i] ?? STAR;
      const pos = (start - origin) * zoom;
      const label = formatLength(def.size);
      const limits = [def.min !== null ? `≥ ${formatNumber(def.min)}` : "", def.max !== null ? `≤ ${formatNumber(def.max)}` : ""].filter(Boolean).join(" ");
      return (
        <div
          key={`s${i}`}
          className="yui-grid-rail-segment"
          data-kind={def.size.t}
          style={horizontal ? { left: pos, width: size * zoom } : { top: pos, height: size * zoom }}
          title={`${label}${limits ? ` (${limits})` : ""} — ${formatNumber(Math.round(size * 10) / 10)} px`}
          onContextMenu={(e) => menuFor(e, i)}
        >
          {size * zoom >= 18 && <span>{label}</span>}
        </div>
      );
    });
    const grips = lines.slice(1).map((_, k) => {
      const i = k + 1;
      const shift = drag?.axis === axis && drag.kind === "resize" && drag.index === i ? drag.delta : 0;
      const pos = (boundary(lines, i) + shift - origin) * zoom;
      return <div key={`g${i}`} data-grip={i} className="yui-grid-rail-grip" style={horizontal ? { left: pos } : { top: pos }} title={t("Drag to resize")} />;
    });
    return (
      <div
        key={axis}
        className={`yui-grid-rail yui-grid-rail-${horizontal ? "top" : "left"}`}
        data-editable={editable || undefined}
        style={style}
        title={editable ? t("Click to add a {what}", { what }) : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        onPointerLeave={() => setHover(null)}
      >
        {segments}
        {grips}
      </div>
    );
  };

  // The line being added or moved, across the grid.
  const c = geo.content;
  let guide: ReactNode = null;
  const lineAt = (axis: Axis, at: number, kind: string) =>
    axis === "cols" ? (
      <div className={`yui-grid-guide yui-grid-guide-v ${kind}`} style={{ left: at * zoom, top: c.y * zoom, height: c.h * zoom }} />
    ) : (
      <div className={`yui-grid-guide yui-grid-guide-h ${kind}`} style={{ left: c.x * zoom, top: at * zoom, width: c.w * zoom }} />
    );
  if (drag?.kind === "resize") guide = lineAt(drag.axis, boundary(drag.axis === "cols" ? geo.cols : geo.rows, drag.index) + drag.delta, "moving");
  else if (editable && (drag?.kind === "add" ? !drag.moved : hover)) {
    const h = drag?.kind === "add" ? drag : hover!;
    guide = lineAt(h.axis, Math.round(h.at), "adding");
  }

  return (
    <>
      {rail("cols")}
      {rail("rows")}
      {guide}
    </>
  );
}

// ── The collection editor (Properties' "…" on Rows / Columns) ────────────────

interface DraftRow {
  size: string;
  min: string;
  max: string;
}

const toDraft = (d: TrackDef): DraftRow => ({ size: formatLength(d.size), min: d.min === null ? "" : formatNumber(d.min), max: d.max === null ? "" : formatNumber(d.max) });

function fromDraft(r: DraftRow): TrackDef {
  const limit = (v: string) => {
    const n = parseNumber(v);
    return n === null || n < 0 ? null : n;
  };
  return { size: parseLength(r.size) ?? { t: "star", v: 1 }, min: limit(r.min), max: limit(r.max) };
}

function DefinitionsEditor({ axis, initial, onChange }: { axis: Axis; initial: DraftRow[]; onChange: (rows: DraftRow[]) => void }) {
  const t = useT();
  const [rows, setRows] = useState(initial);
  const update = (next: DraftRow[]) => {
    setRows(next);
    onChange(next);
  };
  const set = (i: number, patch: Partial<DraftRow>) => update(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const move = (i: number, by: number) => {
    const next = [...rows];
    const [r] = next.splice(i, 1);
    next.splice(i + by, 0, r);
    update(next);
  };
  const a = AXES[axis];
  const badLimit = (v: string) => v.trim() !== "" && (parseNumber(v) === null || parseNumber(v)! < 0);
  return (
    <div className="yui-defs-editor">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th title={t("Auto, * (a share of the rest), 2* or pixels (26)")}>{axis === "rows" ? t("Height") : t("Width")}</th>
            <th>{t("Minimum")}</th>
            <th>{t("Maximum")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{i}</td>
              <td>
                <input value={r.size} data-invalid={!parseLength(r.size) || undefined} spellCheck={false} onChange={(e) => set(i, { size: e.target.value })} list="yui-defs-sizes" />
              </td>
              <td>
                <input value={r.min} data-invalid={badLimit(r.min) || undefined} placeholder={a.min} onChange={(e) => set(i, { min: e.target.value })} />
              </td>
              <td>
                <input value={r.max} data-invalid={badLimit(r.max) || undefined} placeholder={a.max} onChange={(e) => set(i, { max: e.target.value })} />
              </td>
              <td className="yui-defs-actions">
                <button type="button" title={t("Move Up")} disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button type="button" title={t("Move Down")} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button type="button" title={t("Remove")} onClick={() => update(rows.filter((_, k) => k !== i))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <datalist id="yui-defs-sizes">
        <option value="Auto" />
        <option value="*" />
        <option value="2*" />
      </datalist>
      <button type="button" className="yui-defs-add" onClick={() => update([...rows, { size: "*", min: "", max: "" }])}>
        {axis === "rows" ? t("Add Row") : t("Add Column")}
      </button>
      <p className="yui-defs-hint">{t("Sizes: Auto fits the content, * shares what's left (2* gets twice as much), a number is pixels. No rows (columns) = one * row (column).")}</p>
    </div>
  );
}

/** Visual Studio's RowDefinition / ColumnDefinition collection editor — the grid with the edited definitions, or `null` if cancelled. */
export async function editDefinitions(grid: YuiNode, axis: Axis): Promise<YuiNode | null> {
  const initial = gridDefs(grid)[axis].map(toDraft);
  let rows = initial;
  const result = await showDialog({
    title: axis === "rows" ? t("Rows (RowDefinitions)") : t("Columns (ColumnDefinitions)"),
    message: <DefinitionsEditor axis={axis} initial={initial} onChange={(r) => (rows = r)} />,
    buttons: [
      { id: "ok", label: t("OK"), variant: "primary" },
      { id: "cancel", label: t("Cancel"), cancel: true },
    ],
  });
  if (result.button !== "ok") return null;
  const defs = rows.map(fromDraft);
  return shiftCells(withGridDefs(grid, axis, defs), axis, 0, 0, Math.max(1, defs.length));
}
