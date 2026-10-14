import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ContextMenu,
  DesignSurface,
  getCurrentSelection,
  notifyDocumentCommands,
  registerDocumentCommands,
  setSelection,
  tn,
  useContextMenu,
  useKeybinding,
  useT,
  type ContextMenuItem,
  type DesignChange,
  type DesignItem,
  type DesignPoint,
  type DesignRect,
  type EditorProps,
  type PropertyDescriptor,
} from "substrate-platform-ui";
import { openFile } from "../fileOpenBus";
import { useActiveFileTab } from "../OpenFilesContext";
import { EVENT, emitTo } from "../events";
import { reportError } from "../reportError";
import { clearActiveDesigner, setActiveDesigner, TOOLBOX_MIME } from "./activeDesigner";
import { charWidth, compute, LINE_GAP, LINE_H, screenWidget, strWidth, textLines, type LNode, type LWidget } from "./layout";
import { imageSourcesVersion, subscribeImageSources } from "./imageSources";
import { widgetProperties } from "./properties";
import { componentBody, designRoot, findComponent, isComponentDoc, useComponents } from "./components";
import {
  adoptUids,
  cloneFresh,
  cssColor,
  findNode,
  findParent,
  formatNumber,
  insertNodes,
  isCanvas,
  isContainer,
  isDescendant,
  isGrid,
  KIND_INFO,
  KINDS,
  mapNode,
  newNode,
  newScreen,
  nodeAtPath,
  parseNodes,
  parseYui,
  pathOf,
  removeNodes,
  serializeNodes,
  serializeYui,
  withAttrs,
  type YuiDoc,
  type YuiKind,
  type YuiNode,
} from "./yui";
import { patchYui } from "./yuiText";
import { cellAt, GridLines, GridRails, type GridGeo } from "./GridAdorner";
import { cellAttrs, cellOf, gridDefs } from "./grid";
import { designText, useDesignResources, withDesignResources } from "../lang/designResources";
import "./ScreenDesigner.css";

/** What Properties shows for the designer's selection (`setSelection` kind `"yui.widget"`). */
export interface YuiSelectionData {
  path: string;
  objectName: string;
  objectType: string;
  /** A component instance's description (its `.yui`'s `description`). */
  objectDescription?: string;
  objectKey: string;
  properties: PropertyDescriptor[];
}

/**
 * The XAML pane of the split view, as the designer sees it (`YuiSplitEditor`):
 * there the text is the document — the designer's edits are written into it
 * (and undone there), and edits typed there come back re-parsed.
 */
export interface DesignerLink {
  /** Writes a designer edit (`prev` → `next`) into the XAML as one undo step; the new text, or `null` when the edit can't be made now (the markup there is invalid or not parsed yet). */
  write: (prev: YuiDoc, next: YuiDoc) => string | null;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** The designer's selection as child-index paths, primary first — the XAML marks it, and moves its cursor there when `reveal`. */
  selected: (paths: number[][], reveal: boolean) => void;
  /** The designer was focused more recently than the XAML — the Edit menu acts on it. */
  preferred: () => boolean;
  /** Called by the designer while it's mounted; returns the detach. */
  attach: (designer: LinkedDesigner) => () => void;
}

/** What the split view can ask of its designer. */
export interface LinkedDesigner {
  /** A valid parse of the XAML after it was edited there. */
  receive: (doc: YuiDoc, text: string) => void;
  /** The XAML cursor is in the element at `path`. */
  selectPath: (path: number[]) => void;
  /** Shows the selection in Properties (focus moved into the XAML). */
  publish: () => void;
}

export interface ScreenDesignerProps extends EditorProps {
  /** Set by the split view — see `DesignerLink`. */
  link?: DesignerLink;
}

/** Common GUI sizes — the game window divided by its GUI scale. */
const RESOLUTIONS: { w: number; h: number; label: string }[] = [
  { w: 480, h: 270, label: "480 × 270 (1920 × 1080, GUI 4)" },
  { w: 640, h: 360, label: "640 × 360 (1920 × 1080, GUI 3)" },
  { w: 960, h: 540, label: "960 × 540 (1920 × 1080, GUI 2)" },
  { w: 427, h: 240, label: "427 × 240 (854 × 480, GUI 2)" },
  { w: 320, h: 240, label: "320 × 240 (minimum window)" },
];
const ZOOMS = [1, 2, 3, 4, 5, 6, 8];
const GRID = 2;

/** One undo step: the document as it was, its exact text (so undoing back to the saved text clears the dirty mark), and what was selected. */
interface HistoryEntry {
  doc: YuiDoc;
  text: string;
  selection: string[];
}

interface Session {
  text: string;
  doc: YuiDoc;
  past: HistoryEntry[];
  future: HistoryEntry[];
  selection: string[];
  /** Linked to the XAML (whose history is CodeMirror's): the selection that went with each text the designer wrote or left — restored when undo/redo brings that text back. */
  selectionByText: Map<string, number[][]>;
}

/** Remembers `selection` (as child-index paths) for `text`, keeping the map small. */
function rememberSelection(s: Session, text: string, doc: YuiDoc, selection: string[]) {
  s.selectionByText.delete(text);
  s.selectionByText.set(
    text,
    selection.map((uid) => pathOf(doc.root, uid)).filter((p): p is number[] => !!p)
  );
  while (s.selectionByText.size > 400) s.selectionByText.delete(s.selectionByText.keys().next().value!);
}

/** Focus is in a text box (or a code editor) whose own Ctrl+Z undoes typing. */
function inTextField(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !["checkbox", "radio", "button", "submit", "range", "color", "file"].includes(el.type);
  return el.isContentEditable;
}

interface ViewSettings {
  res: number;
  zoom: number;
  snap: boolean;
  showGrid: boolean;
}

// Kept per file while the IDE runs: switching to the XAML view and back
// unmounts the designer, but its undo history survives if the text is what
// it left. (In the split view the XAML editor keeps the history instead.)
const sessions = new Map<string, Session>();
let settings: ViewSettings = { res: 0, zoom: 2, snap: true, showGrid: false };
let clipboard: string | null = null;

/** One widget's laid-out geometry. */
interface Geo {
  rect: DesignRect;
  content: DesignRect;
  /** A grid's rows and columns: `[start, size]`. */
  grid?: { rows: [number, number][]; cols: [number, number][] };
}

/** What `yui_designer_render` answers (`src-tauri/src/designer`). */
interface RenderReply {
  image: string;
  scale: number;
  rects: { uid: string; rect: [number, number, number, number]; content: [number, number, number, number]; grid?: { rows: [number, number][]; cols: [number, number][] } }[];
  assets: { version: string; jar: string } | null;
  realFont: boolean;
}

/** A picture drawn by yog-ui itself (the code the game runs), for `root` at `w × h`. */
interface Rendered {
  root: YuiNode;
  w: number;
  h: number;
  image: string;
  geo: Map<string, Geo>;
  assets: RenderReply["assets"];
  realFont: boolean;
}

interface EventReply {
  scrolled: boolean;
  hit: string | null;
  clicked: string | null;
}

interface HandlerLocation {
  path: string;
  line: number;
  column: number;
  changed: boolean;
}

const toRect = ([x, y, w, h]: [number, number, number, number]): DesignRect => ({ x, y, w, h });

/** The event a double-click on `node` opens the handler of (Visual Studio's default event), if it has one. */
function defaultEvent(node: YuiNode): "on_click" | "on_change" | null {
  if (node.kind === "Button") return "on_click";
  if (node.kind === "TextBox") return "on_change";
  return node.kind !== "Screen" && node.attrs.on_click ? "on_click" : null;
}

/** A new event name for `attr` on `node`, like Visual Studio's `button1_Click`: `<id>_click`, unique in the screen. */
function newEventName(root: YuiNode, node: YuiNode, attr: string): string {
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

function collect(widget: LWidget, node: LNode, out: Map<string, Geo>) {
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
const fitParent = (n: YuiNode, parent: YuiNode) =>
  isGrid(parent) || !Object.keys(n.attrs).some((k) => k.startsWith("Grid.")) ? n : withAttrs(n, { "Grid.Row": undefined, "Grid.Column": undefined, "Grid.RowSpan": undefined, "Grid.ColumnSpan": undefined });

/** Spans that would run past a grid's last row/column shortened (after a move into it). */
function clampCells(grid: YuiNode): YuiNode {
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

const positioned = (n: YuiNode, parent: YuiNode | null) => !!parent && (isCanvas(parent) || n.attrs.x !== undefined || n.attrs.y !== undefined);
const round = (v: number) => formatNumber(Math.round(v));

function stemOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "screen";
  return name.replace(/\.yui$/i, "").replace(/[^a-z0-9_]/gi, "_").toLowerCase() || "screen";
}

/** The mod a file belongs to: the folder holding the `src/` it's in. */
function modRootOf(path: string): string | null {
  const m = /^(.*)[\\/]src[\\/]/.exec(path);
  return m ? m[1] : null;
}

function nodeLabel(n: YuiNode): string {
  const name = n.attrs.id ? `${n.attrs.id} ` : "";
  return `${name}(${n.kind})`;
}

export function ScreenDesigner({ path, content, onChange, readOnly, contentVersion, link }: ScreenDesignerProps) {
  const t = useT();
  const activeTab = useActiveFileTab();
  const isActive = activeTab?.path === path;
  const canvasRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewSettings>(settings);
  const [, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const draggingRef = useRef(false);
  /** The next selection change came from the XAML cursor — don't send the cursor back there. */
  const fromTextRef = useRef(false);
  const menu = useContextMenu();
  /** The menu of a grid rail (Auto / * / pixels, insert, delete). */
  const [railMenu, setRailMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  // ── Document & history ────────────────────────────────────────────────────

  const load = useCallback(
    (text: string) => {
      const kept = sessions.get(path);
      if (kept && kept.text === text) {
        sessionRef.current = kept;
        setError(null);
        return;
      }
      if (text.trim() === "") {
        const doc = newScreen(`mymod:${stemOf(path)}`);
        const session: Session = { text: serializeYui(doc), doc, past: [], future: [], selection: [], selectionByText: new Map() };
        sessionRef.current = session;
        sessions.set(path, session);
        setError(null);
        // A new file: name the screen after its mod, and write it out.
        const root = modRootOf(path);
        const finish = (modId: string | null) => {
          const s = sessionRef.current;
          if (!s || s !== session || s.past.length > 0) return;
          if (modId) s.doc = { ...s.doc, root: withAttrs(s.doc.root, { id: `${modId}:${stemOf(path)}` }) };
          s.text = serializeYui(s.doc);
          setRevision((r) => r + 1);
          if (!readOnly) onChange(s.text);
        };
        if (root)
          invoke<{ fields: { id?: string } }>("mod_manifest_read", { projectRoot: root })
            .then((m) => finish(m.fields.id ?? null))
            .catch(() => finish(null));
        else void Promise.resolve().then(() => finish(null));
        return;
      }
      try {
        const doc = parseYui(text);
        const session: Session = { text, doc, past: [], future: [], selection: [], selectionByText: new Map() };
        sessionRef.current = session;
        sessions.set(path, session);
        setError(null);
      } catch (err) {
        sessionRef.current = null;
        setError(String(err instanceof Error ? err.message : err));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path]
  );

  // Linked, the XAML editor takes reloads and passes them on (`receive`).
  const loadedVersion = useRef<number | undefined>(-1);
  if (loadedVersion.current !== contentVersion && !(link && loadedVersion.current !== -1)) {
    loadedVersion.current = contentVersion;
    load(content);
  }

  const session = sessionRef.current;
  const doc = session?.doc ?? null;
  const selection = session?.selection ?? [];

  const commit = useCallback(
    (next: YuiDoc, nextSelection?: string[]) => {
      const s = sessionRef.current;
      if (!s || readOnly || next === s.doc) return;
      const before = s.text;
      if (link) {
        const text = link.write(s.doc, next);
        if (text === null) return;
        rememberSelection(s, before, s.doc, s.selection);
        s.text = text;
      } else {
        s.past.push({ doc: s.doc, text: s.text, selection: s.selection });
        if (s.past.length > 200) s.past.shift();
        s.future = [];
        // Only what changed is rewritten — the rest of the file stays as the user wrote it.
        s.text = patchYui(s.text, s.doc, next);
        onChange(s.text);
      }
      s.doc = next;
      if (nextSelection) s.selection = nextSelection;
      s.selection = s.selection.filter((uid) => findNode(next.root, uid));
      if (link) rememberSelection(s, s.text, next, s.selection);
      setRevision((r) => r + 1);
      notifyDocumentCommands();
    },
    [onChange, readOnly, link]
  );

  const select = useCallback((uids: string[]) => {
    const s = sessionRef.current;
    if (!s) return;
    s.selection = uids;
    setRevision((r) => r + 1);
    notifyDocumentCommands();
  }, []);

  const step = useCallback(
    (back: boolean) => {
      const s = sessionRef.current;
      if (!s || readOnly) return;
      if (link) {
        if (back) link.undo();
        else link.redo();
        return;
      }
      const from = back ? s.past : s.future;
      const to = back ? s.future : s.past;
      const entry = from.pop();
      if (!entry) return;
      to.push({ doc: s.doc, text: s.text, selection: s.selection });
      // The exact text it had — undoing back to what's saved leaves the tab clean.
      s.text = entry.text;
      s.doc = entry.doc;
      s.selection = entry.selection.filter((uid) => findNode(entry.doc.root, uid));
      onChange(s.text);
      setRevision((r) => r + 1);
      notifyDocumentCommands();
    },
    [onChange, readOnly, link]
  );

  // ── Layout ────────────────────────────────────────────────────────────────

  const res = RESOLUTIONS[view.res] ?? RESOLUTIONS[0];
  // `@Strings.title` texts shown from the mod's .yres files (docs/yres.md).
  const resourcesVersion = useDesignResources(modRootOf(path));
  // The mod's components (docs/yui.md, "Components"): what instances draw as, re-drawn when one changes.
  const components = useComponents(path);
  const componentsRevision = components ? `${components.revision}:${components.status}` : "";
  const layout = useMemo(() => {
    if (!doc) return null;
    const widget = screenWidget(designRoot(doc.root), res.w, res.h);
    const tree = compute(widget, res.w, res.h);
    const geo = new Map<string, Geo>();
    collect(widget, tree, geo);
    return { widget, tree, geo };
  }, [doc, res.w, res.h, resourcesVersion]);

  // ── The real picture ──────────────────────────────────────────────────────
  // yog-ui's own layout and render — the code the game runs — drawn with the
  // game's font and textures, read from the local Minecraft client jar
  // (`src-tauri/src/designer`). Without a jar, `layout.ts` stands in.

  const [previewing, setPreviewing] = useState(false);
  /** Preview: what was typed into each text box, by uid. */
  const [previewTexts, setPreviewTexts] = useState<Record<string, string>>({});
  const [focusedBox, setFocusedBox] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  const [previewTick, setPreviewTick] = useState(0);
  const [lastEvent, setLastEvent] = useState<string | null>(null);
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const renderSeq = useRef(0);

  /** What's drawn: the document — in the preview with what was typed into its text boxes, and vanilla's `_` caret in the focused one. */
  const drawnRoot = useMemo(() => {
    if (!doc) return null;
    if (!previewing) return doc.root;
    let root = doc.root;
    const boxes = new Set([...Object.keys(previewTexts), ...(focusedBox ? [focusedBox] : [])]);
    for (const uid of boxes) {
      root = mapNode(root, uid, (n) => {
        const typed = previewTexts[uid] ?? (n.attrs.text?.startsWith("@") && !n.attrs.text.startsWith("@@") ? "" : (n.attrs.text ?? ""));
        const shown = uid === focusedBox ? `${typed}_` : typed;
        return withAttrs(n, { text: shown === "" ? undefined : shown.startsWith("@") ? `@${shown}` : shown });
      });
    }
    return root;
  }, [doc, previewing, previewTexts, focusedBox]);

  useEffect(() => {
    if (!drawnRoot) return;
    const seq = ++renderSeq.current;
    const scale = Math.min(8, view.zoom * Math.max(1, Math.round(window.devicePixelRatio || 1)));
    const { w, h } = res;
    // A short debounce: typing in the XAML re-parses on every key.
    const timer = setTimeout(() => {
      invoke<RenderReply>("yui_designer_render", { args: { path, root: withDesignResources(drawnRoot), screenW: w, screenH: h, scale, preview: previewing } })
        .then((reply) => {
          if (seq !== renderSeq.current) return;
          const geo = new Map<string, Geo>(reply.rects.map((r) => [r.uid, { rect: toRect(r.rect), content: toRect(r.content), grid: r.grid }]));
          setRendered({ root: drawnRoot, w, h, image: reply.image, geo, assets: reply.assets, realFont: reply.realFont });
          setRenderError(null);
        })
        .catch((err) => {
          if (seq !== renderSeq.current) return;
          setRendered(null);
          setRenderError(String(err instanceof Error ? err.message : err));
        });
    }, 16);
    return () => clearTimeout(timer);
  }, [path, drawnRoot, res, view.zoom, previewing, previewTick, resourcesVersion, componentsRevision]);

  useEffect(() => () => void invoke("yui_designer_reset", { path }).catch(() => {}), [path]);

  /** The picture for this GUI size (possibly of the previous edit, until the next one arrives). */
  const picture = rendered && rendered.w === res.w && rendered.h === res.h && rendered.assets ? rendered : null;
  /** Where things are: yog-ui's layout when the picture is of this very document, else `layout.ts`'s (the same rules, in TypeScript). */
  const geo = rendered && doc && rendered.root === doc.root && rendered.w === res.w && rendered.h === res.h ? rendered.geo : layout?.geo;

  const items = useMemo<DesignItem[]>(() => {
    if (!doc || !geo) return [];
    const out: DesignItem[] = [];
    const visit = (n: YuiNode, parent: YuiNode | null) => {
      const g = geo.get(n.uid);
      if (!g) return;
      const free = positioned(n, parent);
      out.push({
        id: n.uid,
        rect: g.rect,
        contentRect: g.content,
        parentId: parent?.uid ?? null,
        container: isContainer(n),
        placement: parent ? (free ? "free" : "flow") : "fixed",
        handles: parent ? undefined : n.attrs.anchor === "fill" ? [] : ["e", "s", "se"],
        label: nodeLabel(n),
      });
      if (isContainer(n) || isComponentDoc(n)) n.children.forEach((c) => visit(c, n));
    };
    visit(doc.root, null);
    return out;
  }, [doc, geo]);

  // ── Edits ─────────────────────────────────────────────────────────────────

  /**
   * Where something added into `target` really goes: a component document's
   * root holds one body — new widgets go into it (a container), or become it
   * (none yet); null when the body can't hold any.
   */
  const intoTarget = (d: YuiDoc, target: YuiNode): YuiNode | null => {
    if (target.uid !== d.root.uid || !isComponentDoc(d.root)) return target;
    const body = componentBody(d.root);
    return !body ? d.root : isContainer(body) ? body : null;
  };

  /** The container a new/pasted widget goes into: the selected container, else the selection's container, else the screen. */
  const insertionTarget = (d: YuiDoc, sel: string[]): YuiNode | null => {
    const primary = sel[0] ? findNode(d.root, sel[0]) : null;
    if (primary && isContainer(primary)) return intoTarget(d, primary);
    return intoTarget(d, (primary && findParent(d.root, primary.uid)) || d.root);
  };

  /** A built-in kind or one of the mod's components — what may be added (never a root, nor a component into itself). */
  const addable = (kind: string) => {
    const root = sessionRef.current?.doc.root;
    if (kind === "Screen" || (root && isComponentDoc(root) && root.attrs.name === kind)) return false;
    return (KINDS as readonly string[]).includes(kind) || !!findComponent(components, kind);
  };

  /** Index among `container`'s children where something dropped at `point` goes (flow containers). */
  const flowIndex = (container: YuiNode, point: DesignPoint, skip: ReadonlySet<string>): number => {
    const row = container.kind === "Row";
    let index = 0;
    for (const c of container.children) {
      if (skip.has(c.uid)) continue;
      const g = geo?.get(c.uid);
      if (g && c.attrs.x === undefined && c.attrs.y === undefined) {
        const mid = row ? g.rect.x + g.rect.w / 2 : g.rect.y + g.rect.h / 2;
        if ((row ? point.x : point.y) < mid) return index;
      }
      index++;
    }
    return index;
  };

  /** A laid-out grid's geometry (`null` while it isn't laid out). */
  const gridGeo = (uid: string): GridGeo | null => {
    const g = geo?.get(uid);
    return g?.grid ? { rect: g.rect, content: g.content, rows: g.grid.rows, cols: g.grid.cols } : null;
  };

  const placeNew = (d: YuiDoc, node: YuiNode, target: YuiNode, point: DesignPoint | null): YuiDoc => {
    const content = geo?.get(target.uid)?.content;
    node = fitParent(node, target);
    if (isGrid(target)) {
      // Dropped into a cell: that's its Grid.Row / Grid.Column.
      const gg = gridGeo(target.uid);
      const [row, col] = point && gg ? cellAt(gg, point.x, point.y) : [0, 0];
      node = withAttrs(node, { x: undefined, y: undefined, ...cellAttrs(row, col) });
      return { ...d, root: mapNode(insertNodes(d.root, target.uid, target.children.length, [node]), target.uid, clampCells) };
    }
    if (isCanvas(target)) {
      let x = point && content ? point.x - content.x : 8;
      let y = point && content ? point.y - content.y : 8;
      // Don't stack exactly on a sibling (repeated double-clicks, pastes).
      while (target.children.some((c) => c.attrs.x === round(x) && c.attrs.y === round(y))) {
        x += 8;
        y += 8;
      }
      node = withAttrs(node, { x: round(Math.max(0, x)), y: round(Math.max(0, y)) });
      return { ...d, root: insertNodes(d.root, target.uid, target.children.length, [node]) };
    }
    const index = point ? flowIndex(target, point, new Set()) : target.children.length;
    return { ...d, root: insertNodes(d.root, target.uid, index, [withAttrs(node, { x: undefined, y: undefined })]) };
  };

  const addWidget = (kind: string, point: DesignPoint | null = null, targetUid: string | null = null) => {
    const s = sessionRef.current;
    if (!s || !addable(kind)) return;
    const picked = (targetUid && findNode(s.doc.root, targetUid)) || (point ? s.doc.root : null);
    const target = picked ? intoTarget(s.doc, picked) : insertionTarget(s.doc, s.selection);
    if (!target) return;
    let node = newNode(kind);
    // A component comes in at its design size, when it declares one.
    const info = findComponent(components, kind);
    if (info?.design_w) node = withAttrs(node, { w: String(info.design_w) });
    if (info?.design_h) node = withAttrs(node, { h: String(info.design_h) });
    commit(placeNew(s.doc, node, target, point), [node.uid]);
  };

  /** Selected uids that can be cut/deleted/moved — not the screen, and not inside another selected one. */
  const movable = (d: YuiDoc, sel: string[]) =>
    sel.filter((uid) => uid !== d.root.uid && findNode(d.root, uid) && !sel.some((o) => o !== uid && isDescendant(d.root, o, uid)));

  const deleteSelection = () => {
    const s = sessionRef.current;
    if (!s) return;
    const uids = movable(s.doc, s.selection);
    if (uids.length === 0) return;
    const parent = findParent(s.doc.root, uids[0]);
    commit({ ...s.doc, root: removeNodes(s.doc.root, new Set(uids)) }, parent ? [parent.uid] : []);
  };

  const copySelection = () => {
    const s = sessionRef.current;
    if (!s) return false;
    const nodes = movable(s.doc, s.selection).map((uid) => findNode(s.doc.root, uid)!);
    if (nodes.length === 0) return false;
    clipboard = serializeNodes(nodes);
    navigator.clipboard?.writeText(clipboard).catch(() => {});
    notifyDocumentCommands();
    return true;
  };

  const paste = (text: string | null = clipboard) => {
    const s = sessionRef.current;
    const nodes = text ? parseNodes(text) : null;
    if (!s || !nodes) return;
    const target = insertionTarget(s.doc, s.selection);
    if (!target) return;
    let d = s.doc;
    const added: string[] = [];
    for (const n of nodes) {
      if (!addable(n.kind)) continue;
      let copy = cloneFresh(n);
      const x = Number(copy.attrs.x ?? 0);
      const y = Number(copy.attrs.y ?? 0);
      const into = findNode(d.root, target.uid)!;
      copy = fitParent(copy, into);
      // A component has one body.
      if (into.uid === d.root.uid && componentBody(d.root)) break;
      if (isCanvas(into)) {
        let px = x;
        let py = y;
        while (into.children.some((c) => c.attrs.x === round(px) && c.attrs.y === round(py))) {
          px += 8;
          py += 8;
        }
        d = { ...d, root: insertNodes(d.root, into.uid, into.children.length, [withAttrs(copy, { x: round(px), y: round(py) })]) };
      } else {
        d = { ...d, root: insertNodes(d.root, into.uid, into.children.length, [copy]) };
      }
      added.push(copy.uid);
    }
    if (added.length) commit(d, added);
  };

  const duplicate = () => {
    const s = sessionRef.current;
    if (!s) return;
    const uids = movable(s.doc, s.selection);
    let d = s.doc;
    const added: string[] = [];
    for (const uid of uids) {
      const parent = findParent(d.root, uid)!;
      if (parent.uid === d.root.uid && isComponentDoc(d.root)) continue; // a component has one body
      const node = findNode(d.root, uid)!;
      let copy = cloneFresh(node);
      if (positioned(node, parent)) copy = withAttrs(copy, { x: round(Number(node.attrs.x ?? 0) + 8), y: round(Number(node.attrs.y ?? 0) + 8) });
      if (copy.attrs.id) copy = withAttrs(copy, { id: undefined });
      const index = parent.children.findIndex((c) => c.uid === uid);
      d = { ...d, root: insertNodes(d.root, parent.uid, index + 1, [copy]) };
      added.push(copy.uid);
    }
    if (added.length) commit(d, added);
  };

  const reorder = (toFront: boolean) => {
    const s = sessionRef.current;
    if (!s) return;
    let d = s.doc;
    for (const uid of movable(d, s.selection)) {
      const parent = findParent(d.root, uid)!;
      const node = findNode(d.root, uid)!;
      d = { ...d, root: removeNodes(d.root, new Set([uid])) };
      d = { ...d, root: insertNodes(d.root, parent.uid, toFront ? parent.children.length : 0, [node]) };
    }
    commit(d);
  };

  /** Arrow keys: free widgets move (Shift = resize), flowing ones change places with a sibling. */
  const nudge = (dx: number, dy: number, resize: boolean) => {
    const s = sessionRef.current;
    if (!s || !geo) return;
    let d = s.doc;
    for (const uid of movable(d, s.selection)) {
      const parent = findParent(d.root, uid)!;
      const node = findNode(d.root, uid)!;
      const g = geo.get(uid);
      if (!g) continue;
      if (resize) {
        d = { ...d, root: mapNode(d.root, uid, (n) => withAttrs(n, { w: round(Math.max(1, g.rect.w + dx)), h: round(Math.max(1, g.rect.h + dy)) })) };
      } else if (positioned(node, parent)) {
        const pc = geo.get(parent.uid)!.content;
        d = { ...d, root: mapNode(d.root, uid, (n) => withAttrs(n, { x: round(g.rect.x - pc.x + dx), y: round(g.rect.y - pc.y + dy) })) };
      } else if (isGrid(parent)) {
        // In a grid: to the next cell.
        const defs = gridDefs(parent);
        const c = cellOf(node);
        const row = Math.max(0, Math.min(Math.max(1, defs.rows.length) - c.rowSpan, c.row + Math.sign(dy)));
        const col = Math.max(0, Math.min(Math.max(1, defs.cols.length) - c.colSpan, c.col + Math.sign(dx)));
        d = { ...d, root: mapNode(d.root, uid, (n) => withAttrs(n, cellAttrs(row, col))) };
      } else {
        const index = parent.children.findIndex((c) => c.uid === uid);
        const to = index + Math.sign(dx + dy);
        if (to < 0 || to >= parent.children.length) continue;
        d = { ...d, root: removeNodes(d.root, new Set([uid])) };
        d = { ...d, root: insertNodes(d.root, parent.uid, to, [node]) };
      }
    }
    // A resized screen: its own width/height.
    if (resize && s.selection[0] === d.root.uid && geo.get(d.root.uid)) {
      const g = geo.get(d.root.uid)!;
      d = { ...d, root: withAttrs(d.root, { width: round(Math.max(1, g.rect.w + dx)), height: round(Math.max(1, g.rect.h + dy)) }) };
    }
    commit(d);
  };

  const onCommit = (change: DesignChange) => {
    const s = sessionRef.current;
    if (!s || !geo) return;
    let d = s.doc;
    if (change.kind === "resize") {
      const node = findNode(d.root, change.id);
      if (!node) return;
      const r = change.rect;
      if (node.uid === d.root.uid) {
        // A component document's canvas is its design size.
        const [wk, hk] = isComponentDoc(d.root) ? ["design_w", "design_h"] : ["width", "height"];
        commit({ ...d, root: withAttrs(d.root, { [wk]: round(r.w), [hk]: round(r.h) }) });
        return;
      }
      const parent = findParent(d.root, node.uid)!;
      const changes: Record<string, string> = { w: round(r.w), h: round(r.h) };
      if (positioned(node, parent)) {
        const pc = geo.get(parent.uid)!.content;
        changes.x = round(r.x - pc.x);
        changes.y = round(r.y - pc.y);
      }
      commit({ ...d, root: mapNode(d.root, node.uid, (n) => withAttrs(n, changes)) });
      return;
    }
    const ids = change.ids.filter((uid) => uid !== d.root.uid && findNode(d.root, uid));
    if (ids.length === 0) return;
    const lead = findParent(d.root, ids[0])!;
    let targetUid = change.target ?? lead.uid;
    if (ids.some((uid) => uid === targetUid || isDescendant(d.root, uid, targetUid)) || !findNode(d.root, targetUid)) targetUid = lead.uid;
    // A component has one body: what's dropped onto its root goes into the body.
    if (targetUid === d.root.uid && isComponentDoc(d.root) && !ids.every((uid) => findParent(d.root, uid)?.uid === d.root.uid)) {
      const into = intoTarget(d, d.root);
      targetUid = into && into.uid !== d.root.uid ? into.uid : lead.uid;
    }
    const target = findNode(d.root, targetUid)!;
    const stayFree = ids.every((uid) => findParent(d.root, uid)?.uid === targetUid && positioned(findNode(d.root, uid)!, target));
    if (isGrid(target) && !stayFree) {
      // Into the cell under the pointer (each widget of a group at its own offset from the lead's).
      const gg = gridGeo(targetUid);
      const lead0 = change.rects[ids[0]];
      for (const uid of ids) {
        const r = change.rects[uid];
        const [row, col] = gg && r && lead0 ? cellAt(gg, change.point.x + r.x - lead0.x, change.point.y + r.y - lead0.y) : [0, 0];
        const moved = withAttrs(findNode(d.root, uid)!, { x: undefined, y: undefined, ...cellAttrs(row, col) });
        if (findParent(d.root, uid)?.uid === targetUid) d = { ...d, root: mapNode(d.root, uid, () => moved) };
        else {
          d = { ...d, root: removeNodes(d.root, new Set([uid])) };
          const into = findNode(d.root, targetUid)!;
          d = { ...d, root: insertNodes(d.root, targetUid, into.children.length, [moved]) };
        }
      }
      d = { ...d, root: mapNode(d.root, targetUid, clampCells) };
    } else if (isCanvas(target) || stayFree) {
      const content = geo.get(targetUid)!.content;
      for (const uid of ids) {
        const r = change.rects[uid];
        if (!r) continue;
        const moved = fitParent(withAttrs(findNode(d.root, uid)!, { x: round(r.x - content.x), y: round(r.y - content.y) }), target);
        if (findParent(d.root, uid)?.uid === targetUid) d = { ...d, root: mapNode(d.root, uid, () => moved) };
        else {
          d = { ...d, root: removeNodes(d.root, new Set([uid])) };
          const into = findNode(d.root, targetUid)!;
          d = { ...d, root: insertNodes(d.root, targetUid, into.children.length, [moved]) };
        }
      }
    } else {
      const nodes = ids.map((uid) => fitParent(withAttrs(findNode(d.root, uid)!, { x: undefined, y: undefined }), target));
      const index = flowIndex(target, change.point, new Set(ids));
      d = { ...d, root: removeNodes(d.root, new Set(ids)) };
      d = { ...d, root: insertNodes(d.root, targetUid, index, nodes) };
    }
    commit(d);
  };

  /** Properties → the selected widgets (the screen when nothing is). */
  const applyAttr = (attr: string, value: string | undefined): string | null => {
    const s = sessionRef.current;
    if (!s) return null;
    const uids = s.selection.length ? s.selection : [s.doc.root.uid];
    if (attr === "id" && value === undefined && uids.includes(s.doc.root.uid)) return t("The screen needs an id — its UI id, like mymod:main_menu.");
    if (attr === "id" && value !== undefined && uids[0] !== s.doc.root.uid) {
      let clash = false;
      const visit = (n: YuiNode) => {
        if (n.uid !== uids[0] && n.attrs.id === value) clash = true;
        n.children.forEach(visit);
      };
      visit(s.doc.root);
      if (clash) return t("Another widget already has this id.");
    }
    let root = s.doc.root;
    for (const uid of uids) root = mapNode(root, uid, (n) => withAttrs(n, { [attr]: value }));
    commit({ ...s.doc, root });
    return null;
  };

  // ── Selection → Properties ────────────────────────────────────────────────

  // Image sources and previews load in the background: re-publish when they arrive.
  useSyncExternalStore(subscribeImageSources, imageSourcesVersion);

  const publish = () => {
    const s = sessionRef.current;
    if (!s) return;
    const uids = s.selection.length ? s.selection : [s.doc.root.uid];
    const nodes = uids.map((uid) => findNode(s.doc.root, uid)).filter((n): n is YuiNode => !!n);
    const first = nodes[0];
    if (!first) return;
    const instanceOf = nodes.length === 1 ? findComponent(components, first.kind) : null;
    const data: YuiSelectionData = {
      path,
      objectName: nodes.length > 1 ? tn(nodes.length, "{count} widget", "{count} widgets", { count: nodes.length }) : (first.attrs.id ?? first.attrs.name ?? ""),
      objectType:
        nodes.length > 1
          ? ""
          : KIND_INFO[first.kind as YuiKind]
            ? t(KIND_INFO[first.kind as YuiKind].label)
            : instanceOf
              ? t("{name} (component)", { name: designText(instanceOf.display_name || instanceOf.name) })
              : first.kind,
      objectDescription: instanceOf?.description ? designText(instanceOf.description) : undefined,
      objectKey: `${path}#${uids.join(",")}`,
      properties: widgetProperties(
        nodes,
        applyAttr,
        {
          suggest: (node, attr) => newEventName(s.doc.root, node, attr),
          open: (node, attr) => void openHandlerRef.current(node.uid, attr),
        },
        path,
        components,
        {
          inGrid: nodes.every((n) => {
            const parent = findParent(s.doc.root, n.uid);
            return !!parent && isGrid(parent);
          }),
          update: (fn) => {
            const cur = sessionRef.current;
            if (!cur) return null;
            let root = cur.doc.root;
            for (const uid of uids) root = mapNode(root, uid, fn);
            commit({ ...cur.doc, root });
            return null;
          },
        },
      ),
    };
    setSelection({ id: data.objectKey, kind: "yui.widget", data, source: "editor" });
  };
  const publishRef = useRef(publish);
  publishRef.current = publish;

  useEffect(() => {
    const current = getCurrentSelection<YuiSelectionData>();
    if (current?.kind === "yui.widget" && current.data.path === path) publishRef.current();
  });

  // ── Commands (Edit menu, Toolbox, keys) ───────────────────────────────────

  const commands = useRef({ deleteSelection, copySelection, paste, duplicate, step, addWidget, select, reorder, nudge });
  commands.current = { deleteSelection, copySelection, paste, duplicate, step, addWidget, select, reorder, nudge };

  useEffect(
    () =>
      registerDocumentCommands(path, {
        canUndo: () => !readOnly && (link ? link.canUndo() : (sessionRef.current?.past.length ?? 0) > 0),
        undo: () => commands.current.step(true),
        canRedo: () => !readOnly && (link ? link.canRedo() : (sessionRef.current?.future.length ?? 0) > 0),
        redo: () => commands.current.step(false),
        hasSelection: () => {
          const s = sessionRef.current;
          return !!s && movable(s.doc, s.selection).length > 0;
        },
        cut: () => commands.current.copySelection() && commands.current.deleteSelection(),
        copy: () => void commands.current.copySelection(),
        canPaste: () => !readOnly && !!clipboard,
        paste: () => commands.current.paste(),
        selectAll: () => {
          const s = sessionRef.current;
          if (s) commands.current.select(s.doc.root.children.map((c) => c.uid));
        },
        delete: () => commands.current.deleteSelection(),
        preferred: link?.preferred,
      }),
    [path, readOnly, link]
  );

  // ── The split view's XAML pane ────────────────────────────────────────────

  useEffect(
    () =>
      link?.attach({
        receive: (doc, text) => {
          const s = sessionRef.current;
          if (s) {
            // Same nodes, same uids: the selection survives the re-parse —
            // and a text undo/redo brought back gets the selection it had.
            s.doc = { ...doc, root: adoptUids(s.doc.root, doc.root) };
            s.text = text;
            const remembered = s.selectionByText.get(text);
            s.selection = remembered
              ? remembered.map((p) => nodeAtPath(s.doc.root, p)?.uid).filter((uid): uid is string => !!uid)
              : s.selection.filter((uid) => findNode(s.doc.root, uid));
          } else {
            const session: Session = { text, doc, past: [], future: [], selection: [], selectionByText: new Map() };
            sessionRef.current = session;
            sessions.set(path, session);
          }
          setError(null);
          setRevision((r) => r + 1);
          notifyDocumentCommands();
        },
        selectPath: (at) => {
          const s = sessionRef.current;
          const node = s ? nodeAtPath(s.doc.root, at) : null;
          if (!s || !node || (s.selection.length === 1 && s.selection[0] === node.uid)) return;
          fromTextRef.current = true;
          commands.current.select([node.uid]);
          publishRef.current();
        },
        publish: () => publishRef.current(),
      }),
    [link, path]
  );

  // The XAML marks what's selected here (and follows edits), and its cursor
  // goes to a newly selected element — unless the selection came from there.
  const selectionKey = selection.join(",");
  useEffect(() => {
    if (link && doc) link.selected(selection.map((uid) => pathOf(doc.root, uid)).filter((p): p is number[] => !!p), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, doc]);
  useEffect(() => {
    const reveal = !fromTextRef.current;
    fromTextRef.current = false;
    if (link && doc) link.selected(selection.map((uid) => pathOf(doc.root, uid)).filter((p): p is number[] => !!p), reveal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, selectionKey]);

  useEffect(() => {
    if (!isActive || !doc) return;
    setActiveDesigner({
      path,
      doc,
      selection,
      select: (uids) => {
        commands.current.select(uids);
        publishRef.current();
      },
      addWidget: (kind) => commands.current.addWidget(kind),
      focus: () => (canvasRef.current?.querySelector(".sp-design-surface") as HTMLElement | null)?.focus(),
    });
  }, [isActive, path, doc, selection]);
  useEffect(() => () => clearActiveDesigner(path), [path]);
  useEffect(() => {
    if (!isActive) clearActiveDesigner(path);
  }, [isActive, path]);

  // ── Event handlers (code-behind) ──────────────────────────────────────────

  /**
   * As in Visual Studio: the handler of `node`'s `attr` event in the
   * screen's code-behind `.rs` — the event named first if it has none
   * (`<id>_click`), the handler added if missing — opened at its body.
   */
  const openHandler = async (uid: string, attr: string, name?: string) => {
    const s = sessionRef.current;
    const node = s ? findNode(s.doc.root, uid) : null;
    if (!s || !node) return;
    let event = node.attrs[attr];
    if (!event) {
      if (readOnly) return;
      event = name ?? newEventName(s.doc.root, node, attr);
      const before = s.doc;
      commit({ ...s.doc, root: mapNode(s.doc.root, uid, (n) => withAttrs(n, { [attr]: event })) });
      if (s.doc === before) return; // not written (the XAML can't take it now)
    }
    try {
      const at = await invoke<HandlerLocation>("yui_event_handler", { path, event });
      openFile({ path: at.path, line: at.line, column: at.column });
      if (at.changed) emitTo(EVENT.ideOutput, `[designer] ${t("Added handler for {event} to {file}", { event, file: at.path })}`);
    } catch (err) {
      reportError(t("Couldn't open the handler for {event}: {error}", { event, error: String(err instanceof Error ? err.message : err) }));
    }
  };
  const openHandlerRef = useRef(openHandler);
  openHandlerRef.current = openHandler;

  // ── Preview ───────────────────────────────────────────────────────────────

  const pageRef = useRef<HTMLDivElement>(null);
  const drawnRef = useRef(drawnRoot);
  drawnRef.current = drawnRoot;
  const eventBusy = useRef(false);
  const queuedMove = useRef<[string, number, number] | null>(null);

  /** An event the screen would get: the status bar and Output show it, as the game's code-behind would receive it. */
  const fired = (what: string) => {
    setLastEvent(what);
    emitTo(EVENT.ideOutput, `[designer] ${what}`);
  };

  const sendEvent = (event: string, x: number, y: number) => {
    const root = drawnRef.current;
    if (!root) return;
    const motion = event.startsWith("move:") || event.startsWith("drag:");
    if (motion && eventBusy.current) {
      queuedMove.current = [event, x, y];
      return;
    }
    eventBusy.current = true;
    invoke<EventReply>("yui_designer_event", { args: { path, root: withDesignResources(root), screenW: res.w, screenH: res.h, event, x, y } })
      .then((r) => {
        setHovered(r.hit);
        if (event.startsWith("click:")) setPressed(r.hit);
        if (r.scrolled) setPreviewTick((n) => n + 1);
        if (r.clicked) fired(`click: ${r.clicked}`);
      })
      .catch(() => {})
      .finally(() => {
        eventBusy.current = false;
        const next = queuedMove.current;
        queuedMove.current = null;
        if (next) sendEventRef.current(...next);
      });
  };
  const sendEventRef = useRef(sendEvent);
  sendEventRef.current = sendEvent;

  const togglePreview = () => {
    if (previewing) void invoke("yui_designer_reset", { path }).catch(() => {});
    setPreviewTexts({});
    setFocusedBox(null);
    setHovered(null);
    setPressed(null);
    setLastEvent(null);
    setPreviewing(!previewing);
  };

  const guiPoint = (e: { clientX: number; clientY: number }) => {
    const r = pageRef.current?.getBoundingClientRect();
    return r ? { x: (e.clientX - r.left) / view.zoom, y: (e.clientY - r.top) / view.zoom } : { x: -1, y: -1 };
  };
  const fmt = (v: number) => v.toFixed(2);

  /** The enabled text box under a point (the last drawn wins). */
  const textBoxAt = (x: number, y: number): YuiNode | null => {
    const g = rendered?.geo ?? geo;
    let found: YuiNode | null = null;
    const visit = (n: YuiNode) => {
      const r = g?.get(n.uid)?.rect;
      if (n.kind === "TextBox" && n.attrs.enabled !== "false" && r && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) found = n;
      n.children.forEach(visit);
    };
    if (doc) visit(doc.root);
    return found;
  };

  const typeInto = (box: YuiNode, update: (text: string) => string) => {
    const before = previewTexts[box.uid] ?? (box.attrs.text?.startsWith("@") && !box.attrs.text.startsWith("@@") ? "" : (box.attrs.text ?? ""));
    let after = update(before);
    const max = Number(box.attrs.max_length ?? 0);
    if (max > 0) after = [...after].slice(0, max).join("");
    if (after === before) return;
    setPreviewTexts({ ...previewTexts, [box.uid]: after });
    if (box.attrs.on_change) fired(`change: ${box.attrs.on_change} ${JSON.stringify(after)}`);
  };

  const onPreviewKey = (e: ReactKeyboardEvent) => {
    const box = focusedBox && doc ? findNode(doc.root, focusedBox) : null;
    if (!box) return;
    if (e.key === "Escape") setFocusedBox(null);
    else if (e.key === "Enter") {
      if (box.attrs.on_submit) fired(`submit: ${box.attrs.on_submit}`);
    } else if (e.key === "Backspace") typeInto(box, (text) => [...text].slice(0, -1).join(""));
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
      void navigator.clipboard?.readText().then((clip) => typeInto(box, (text) => text + clip.replace(/[\r\n]/g, "")));
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) typeInto(box, (text) => text + e.key);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const focused = () => {
    const el = document.activeElement;
    return !!el && el.classList.contains("sp-design-surface") && !!canvasRef.current?.contains(el);
  };
  const editable = () => focused() && !readOnly;
  const keyOpts = { when: editable };
  // Undo/redo, as in Visual Studio, act on the active designer from anywhere
  // that has no undo of its own — the canvas, the Toolbox, Document Outline,
  // the Properties grid between edits — not just while the canvas has focus.
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const historyOpts = { when: () => !readOnly && (focused() || (isActiveRef.current && !inTextField())) };
  useKeybinding(["Delete"], () => commands.current.deleteSelection(), keyOpts);
  useKeybinding("Ctrl+Z", () => commands.current.step(true), historyOpts);
  useKeybinding(["Ctrl+Y", "Ctrl+Shift+Z"], () => commands.current.step(false), historyOpts);
  useKeybinding("Ctrl+C", () => void commands.current.copySelection(), { when: focused });
  useKeybinding("Ctrl+X", () => void (commands.current.copySelection() && commands.current.deleteSelection()), keyOpts);
  useKeybinding("Ctrl+V", () => commands.current.paste(), keyOpts);
  useKeybinding("Ctrl+D", () => commands.current.duplicate(), keyOpts);
  useKeybinding(
    "Ctrl+A",
    () => {
      const s = sessionRef.current;
      if (s) commands.current.select(s.doc.root.children.map((c) => c.uid));
    },
    { when: focused }
  );
  useKeybinding(
    "Escape",
    () => {
      const s = sessionRef.current;
      if (draggingRef.current || !s || s.selection.length === 0) return false;
      const parent = findParent(s.doc.root, s.selection[0]);
      commands.current.select(parent ? [parent.uid] : []);
    },
    { when: focused }
  );
  // Arrows move a widget 1px (Ctrl: 8px); with Shift they resize it.
  const ARROWS: Record<string, [number, number]> = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
  useKeybinding(
    ["Left", "Right", "Up", "Down"].flatMap((k) => [k, `Ctrl+${k}`, `Shift+${k}`, `Ctrl+Shift+${k}`]),
    (e) => {
      const [dx, dy] = ARROWS[e.key.toLowerCase()] ?? [0, 0];
      const by = e.ctrlKey || e.metaKey ? 8 : 1;
      commands.current.nudge(dx * by, dy * by, e.shiftKey);
    },
    keyOpts
  );

  const updateView = (patch: Partial<ViewSettings>) => {
    settings = { ...view, ...patch };
    setView(settings);
  };

  // Ctrl+wheel (a trackpad's pinch) zooms, keeping the point under the
  // cursor in place. A native listener: React's wheel events are passive,
  // and the webview would zoom the whole window.
  const zoomRef = useRef(view.zoom);
  zoomRef.current = view.zoom;
  const hasCanvas = !!doc && !!layout && error === null;
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.deltaY === 0) return;
      e.preventDefault();
      const from = zoomRef.current;
      const i = ZOOMS.indexOf(from);
      const to = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 1 : i) + (e.deltaY < 0 ? 1 : -1)))];
      if (to === from) return;
      const r = el.getBoundingClientRect();
      const [mx, my] = [e.clientX - r.left, e.clientY - r.top];
      const [sx, sy] = [el.scrollLeft, el.scrollTop];
      updateView({ zoom: to });
      requestAnimationFrame(() => {
        el.scrollLeft = ((sx + mx) * to) / from - mx;
        el.scrollTop = ((sy + my) * to) / from - my;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasCanvas]);

  if (error !== null || !doc || !layout) {
    return (
      <div className="yui-designer-error">
        <p>{t("The designer can't show this file:")}</p>
        <pre>{error ?? t("Loading…")}</pre>
        <p>{link ? t("Fix the markup in the XAML pane — the designer follows as soon as it's valid.") : t("Fix it in the XAML view (the XAML button on the tab strip), then come back.")}</p>
      </div>
    );
  }

  const canEdit = !readOnly;
  const hasMovable = movable(doc, selection).length > 0;
  const contextItems: ContextMenuItem[] = [
    { label: t("Cut"), shortcut: "Ctrl+X", disabled: !canEdit || !hasMovable, onSelect: () => copySelection() && deleteSelection() },
    { label: t("Copy"), shortcut: "Ctrl+C", disabled: !hasMovable, onSelect: () => void copySelection() },
    { label: t("Paste"), shortcut: "Ctrl+V", disabled: !canEdit || !clipboard, onSelect: () => paste() },
    { label: t("Duplicate"), shortcut: "Ctrl+D", disabled: !canEdit || !hasMovable, onSelect: duplicate },
    { label: t("Delete"), shortcut: "Delete", disabled: !canEdit || !hasMovable, destructive: true, onSelect: deleteSelection },
    { label: t("Bring to Front"), disabled: !canEdit || !hasMovable, onSelect: () => reorder(true), separatorBefore: true },
    { label: t("Send to Back"), disabled: !canEdit || !hasMovable, onSelect: () => reorder(false) },
    {
      label: t("Select Parent"),
      shortcut: "Escape",
      disabled: selection.length === 0 || selection[0] === doc.root.uid,
      onSelect: () => {
        const parent = findParent(doc.root, selection[0]);
        select(parent ? [parent.uid] : []);
      },
      separatorBefore: true,
    },
  ];

  const primary = selection[0] ? findNode(doc.root, selection[0]) : null;
  const notice = renderError
    ? t("The real renderer failed ({error}) — showing an approximation.", { error: renderError })
    : rendered && !rendered.assets
      ? t("Minecraft's client jar wasn't found (in ~/.minecraft/versions or a loader's Gradle caches) — showing an approximation instead of the game's font and textures. Once the game has been installed or a loader built, the designer uses them.")
      : null;
  const primaryGeo = primary ? geo?.get(primary.uid) : undefined;
  // Visual Studio's grid rails: on the selected grid, or the grid the selected widget is in.
  const primaryParent = primary ? findParent(doc.root, primary.uid) : null;
  const railGrid = primary && isGrid(primary) ? primary : primaryParent && isGrid(primaryParent) ? primaryParent : null;
  const railGeo = railGrid ? gridGeo(railGrid.uid) : null;
  const allGrids: GridGeo[] = [];
  if (geo) for (const [uid, g] of geo) if (g.grid) allGrids.push(gridGeo(uid)!);

  return (
    <div
      className="yui-designer"
      onFocus={(e) => {
        // Not the file: the widgets are what Properties shows while in here.
        e.stopPropagation();
        if (!(e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement)) publish();
      }}
    >
      <div className="yui-designer-toolbar">
        <label>
          {t("GUI size")}
          <select value={view.res} onChange={(e) => updateView({ res: Number(e.target.value) })}>
            {RESOLUTIONS.map((r, i) => (
              <option key={r.label} value={i}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Zoom")}
          <select value={view.zoom} onChange={(e) => updateView({ zoom: Number(e.target.value) })}>
            {ZOOMS.map((z) => (
              <option key={z} value={z}>
                {z * 100}%
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={view.snap} onChange={(e) => updateView({ snap: e.target.checked })} />
          {t("Snap")}
        </label>
        <label>
          <input type="checkbox" checked={view.showGrid} onChange={(e) => updateView({ showGrid: e.target.checked })} />
          {t("Grid")}
        </label>
        <span className="yui-designer-sep" />
        <button type="button" disabled={!canEdit || !hasMovable} onClick={() => reorder(true)} title={t("Bring to Front")}>
          {t("Bring to Front")}
        </button>
        <button type="button" disabled={!canEdit || !hasMovable} onClick={() => reorder(false)} title={t("Send to Back")}>
          {t("Send to Back")}
        </button>
        <span className="yui-designer-sep" />
        <button
          type="button"
          aria-pressed={previewing}
          data-active={previewing || undefined}
          onClick={togglePreview}
          title={previewing ? t("Back to designing: select, move and resize widgets.") : t("Try the screen as in game: hover and press buttons, type into text boxes, scroll lists. Events are shown, not run.")}
        >
          {t("Preview")}
        </button>
        <span className="yui-designer-status" title={picture?.assets ? t("Drawn by yog-ui with Minecraft {version}'s font and textures ({jar})", { version: picture.assets.version, jar: picture.assets.jar }) : undefined}>
          {previewing
            ? (lastEvent ?? t("Preview — events appear here and in Output (General)."))
            : primary && primaryGeo
            ? `${nodeLabel(primary)} · ${Math.round(primaryGeo.rect.x)}, ${Math.round(primaryGeo.rect.y)} · ${Math.round(primaryGeo.rect.w)} × ${Math.round(primaryGeo.rect.h)}`
            : doc.root.attrs.id}
        </span>
      </div>
      {notice && <div className="yui-designer-notice">{notice}</div>}
      <div
        className="yui-designer-canvas"
        ref={canvasRef}
        onDoubleClick={(e) => {
          // Double-clicking a button opens its click handler, as in Visual Studio.
          if (previewing || !(e.target instanceof Element) || !e.target.closest(".sp-design-surface-page")) return;
          const node = selection[0] ? findNode(doc.root, selection[0]) : null;
          const attr = node && defaultEvent(node);
          if (node && attr) void openHandlerRef.current(node.uid, attr);
        }}
      >
        {previewing ? (
          <div className="yui-preview" tabIndex={0} onKeyDown={onPreviewKey}>
            <div className="yui-preview-canvas" style={{ width: res.w * view.zoom + 64, height: res.h * view.zoom + 64 }}>
              <div
                ref={pageRef}
                className="yui-preview-page"
                data-pointer={hovered ? "button" : focusedBox ? "text" : undefined}
                style={{ width: res.w * view.zoom, height: res.h * view.zoom }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  (e.currentTarget.closest(".yui-preview") as HTMLElement | null)?.focus();
                  const p = guiPoint(e);
                  setFocusedBox(textBoxAt(p.x, p.y)?.uid ?? null);
                  sendEvent(`click:${fmt(p.x)}:${fmt(p.y)}`, p.x, p.y);
                }}
                onPointerMove={(e) => {
                  const p = guiPoint(e);
                  sendEvent(`${e.buttons & 1 ? "drag" : "move"}:${fmt(p.x)}:${fmt(p.y)}`, p.x, p.y);
                }}
                onPointerUp={(e) => {
                  if (e.button !== 0) return;
                  const p = guiPoint(e);
                  setPressed(null);
                  sendEvent(`release:${fmt(p.x)}:${fmt(p.y)}`, p.x, p.y);
                }}
                onPointerLeave={() => setHovered(null)}
                onWheel={(e) => {
                  if (e.deltaY === 0) return;
                  const p = guiPoint(e);
                  sendEvent(`scroll:${e.deltaY < 0 ? 1 : -1}`, p.x, p.y);
                }}
              >
                <div className="yui-world" />
                {rendered && rendered.w === res.w && rendered.h === res.h && rendered.assets ? (
                  <img className="yui-picture" src={rendered.image} alt="" draggable={false} />
                ) : (
                  <McWidget widget={layout.widget} node={layout.tree} zoom={view.zoom} />
                )}
                {hovered && rendered?.geo.get(hovered) && (
                  <div className={`yui-box yui-preview-hot${pressed === hovered ? " pressed" : ""}`} style={box(rendered.geo.get(hovered)!.rect, view.zoom)} />
                )}
              </div>
            </div>
          </div>
        ) : (
        <DesignSurface
          width={res.w}
          height={res.h}
          scale={view.zoom}
          items={items}
          selection={selection}
          onSelectionChange={(uids) => {
            select(uids);
            setTimeout(() => publishRef.current());
          }}
          onPreview={(change) => {
            draggingRef.current = change !== null;
          }}
          onCommit={(change) => !readOnly && onCommit(change)}
          grid={view.snap ? GRID : 0}
          snaplines={view.snap}
          showGrid={view.showGrid}
          externalDrop={
            readOnly
              ? undefined
              : {
                  mime: TOOLBOX_MIME,
                  onDrop: (kind, point, target) => {
                    addWidget(kind, point, target ?? doc.root.uid);
                    setTimeout(() => publishRef.current());
                  },
                }
          }
          onContextMenu={(e) => menu.openAtPoint(undefined, e)}
          adorners={
            railGrid && railGeo ? (
              <GridRails
                grid={railGrid}
                geo={railGeo}
                zoom={view.zoom}
                editable={canEdit}
                onChange={(next) => {
                  const s = sessionRef.current;
                  if (s) commit({ ...s.doc, root: mapNode(s.doc.root, railGrid.uid, () => next) });
                }}
                onMenu={(e, items) => setRailMenu({ x: e.clientX, y: e.clientY, items })}
              />
            ) : undefined
          }
        >
          <div className="yui-world" />
          {picture ? (
            <>
              <img className="yui-picture" src={picture.image} alt="" draggable={false} />
              <DesignOutlines root={doc.root} geo={geo ?? layout.geo} zoom={view.zoom} />
            </>
          ) : (
            <McWidget widget={layout.widget} node={layout.tree} zoom={view.zoom} />
          )}
          <GridLines grids={allGrids} zoom={view.zoom} />
        </DesignSurface>
        )}
      </div>
      <ContextMenu target={menu.target ? { mode: "viewport", x: menu.target.mode === "viewport" ? menu.target.x : 0, y: menu.target.mode === "viewport" ? menu.target.y : 0 } : null} items={contextItems} onClose={menu.close} />
      <ContextMenu target={railMenu ? { mode: "viewport", x: railMenu.x, y: railMenu.y } : null} items={railMenu?.items ?? []} onClose={() => setRailMenu(null)} />
    </div>
  );
}

/** Designer-only dashed outlines of containers and spacers — invisible in game, so drawn over the real picture. */
function DesignOutlines({ root, geo, zoom }: { root: YuiNode; geo: Map<string, Geo>; zoom: number }) {
  const out: ReactNode[] = [];
  const visit = (n: YuiNode) => {
    const g = geo.get(n.uid);
    if (g && (isContainer(n) || n.kind === "Spacer")) out.push(<div key={n.uid} className="yui-box yui-outline" style={box(g.rect, zoom)} />);
    if (isContainer(n)) n.children.forEach(visit);
  };
  visit(root);
  return <>{out}</>;
}

// ── Fallback: Minecraft-like rendering in TypeScript (mirrors `render.rs`) ────

const box = (r: DesignRect, zoom: number): CSSProperties => ({ left: r.x * zoom, top: r.y * zoom, width: r.w * zoom, height: r.h * zoom });

/** Minecraft's drop shadow: the text color at a quarter brightness. */
function shadowOf(argb: number): string {
  const q = (v: number) => Math.floor(v / 4);
  return `rgb(${q((argb >>> 16) & 0xff)}, ${q((argb >>> 8) & 0xff)}, ${q(argb & 0xff)})`;
}

function McText({ text, x, y, scale, color, shadow, zoom }: { text: string; x: number; y: number; scale: number; color: number; shadow: boolean; zoom: number }) {
  const spans: ReactNode[] = [];
  let cx = x;
  let i = 0;
  const opaque = (color >>> 24) === 0 ? (color | 0xff000000) >>> 0 : color;
  for (const ch of text) {
    const w = charWidth(ch) * scale;
    if (ch !== " ")
      spans.push(
        <span
          key={i}
          className="yui-char"
          style={{
            left: cx * zoom,
            top: y * zoom,
            width: w * zoom,
            height: LINE_H * scale * zoom,
            fontSize: 8 * scale * zoom,
            color: cssColor(opaque),
            textShadow: shadow ? `${zoom}px ${zoom}px 0 ${shadowOf(opaque)}` : undefined,
          }}
        >
          {ch}
        </span>
      );
    cx += w;
    i++;
  }
  return <>{spans}</>;
}

function McWidget({ widget, node, zoom }: { widget: LWidget; node: LNode; zoom: number }) {
  if (!widget.visible) return null;
  const r = node.rect;
  const s = widget.style;
  const parts: ReactNode[] = [];
  if (widget.uid !== "" && (s.bg >>> 24) !== 0) parts.push(<div key="bg" className="yui-box" style={{ ...box(r, zoom), background: cssColor(s.bg) }} />);
  const outline = widget.uid !== "" && (widget.kind === "panel" || widget.kind === "spacer");
  if (outline) parts.push(<div key="outline" className="yui-box yui-outline" style={box(r, zoom)} />);

  if (widget.kind === "label" || widget.kind === "button") {
    const availW = Math.max(0, r.w - s.pad[1] - s.pad[3]);
    const lines = textLines(widget.text, s, availW);
    const lineH = LINE_H * s.fontScale + LINE_GAP;
    const totalH = lines.length * lineH - LINE_GAP;
    const contentH = r.h - s.pad[0] - s.pad[2];
    const startY = r.y + s.pad[0] + Math.max(0, (contentH - totalH) / 2);
    lines.forEach((line, i) => {
      const lineW = strWidth(line, s.fontScale);
      let tx = r.x + s.pad[3];
      if (widget.kind === "button") tx += Math.max(0, (availW - lineW) / 2);
      else if (s.align === "center") tx += (availW - lineW) / 2;
      else if (s.align === "end") tx += Math.max(0, availW - lineW);
      parts.push(<McText key={`t${i}`} text={line} x={tx} y={startY + i * lineH} scale={s.fontScale} color={s.color} shadow={s.shadow} zoom={zoom} />);
    });
  } else if (widget.kind === "text_box") {
    // Vanilla EditBox: 1 px grey border, the text (or the greyed placeholder) on one clipped line.
    parts.push(<div key="border" className="yui-box" style={{ ...box(r, zoom), boxShadow: `inset 0 0 0 ${zoom}px #A0A0A0`, overflow: "hidden" }} />);
    const shown = widget.text || widget.placeholder;
    const color = widget.text ? s.color : 0xff707070;
    const ty = r.y + s.pad[0] + Math.max(0, (r.h - s.pad[0] - s.pad[2] - LINE_H * s.fontScale) / 2);
    const inner = { x: r.x + s.pad[3], y: r.y, w: Math.max(0, r.w - s.pad[1] - s.pad[3]), h: r.h };
    parts.push(
      <div key="text" className="yui-box" style={{ ...box(inner, zoom), overflow: "hidden" }}>
        <McText text={shown} x={0} y={ty - r.y} scale={s.fontScale} color={color} shadow={s.shadow} zoom={zoom} />
      </div>
    );
  } else if (widget.kind === "item_slot" || widget.kind === "inv_slot") {
    const slot = { x: r.x + s.pad[3], y: r.y + s.pad[0], w: 18, h: 18 };
    const name = widget.item.split(":").pop() ?? "";
    parts.push(
      <div key="slot" className={`yui-box ${widget.kind === "inv_slot" ? "yui-inv-slot" : "yui-item-slot"}`} style={{ ...box(slot, zoom), borderWidth: zoom }} title={widget.item}>
        <span className="yui-item" style={{ fontSize: 6 * zoom }}>
          {name.slice(0, 2)}
        </span>
      </div>
    );
    if (widget.kind === "inv_slot" && widget.count > 1)
      parts.push(<McText key="count" text={String(widget.count)} x={slot.x + 17 - strWidth(String(widget.count), 1)} y={slot.y + 9} scale={1} color={0xffffffff} shadow zoom={zoom} />);
  } else if (widget.kind === "image") {
    parts.push(
      <div key="img" className="yui-box yui-image" style={box({ x: r.x + s.pad[3], y: r.y + s.pad[0], w: Math.max(0, r.w - s.pad[1] - s.pad[3]), h: Math.max(0, r.h - s.pad[0] - s.pad[2]) }, zoom)} title={widget.source}>
        <span style={{ fontSize: 6 * zoom }}>{widget.source.split("/").pop()}</span>
      </div>
    );
  }
  widget.children.forEach((c, i) => node.children[i] && parts.push(<McWidget key={c.uid || i} widget={c} node={node.children[i]} zoom={zoom} />));
  return <>{parts}</>;
}
