import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import { useActiveFileTab } from "../OpenFilesContext";
import { clearActiveDesigner, setActiveDesigner, TOOLBOX_MIME } from "./activeDesigner";
import { charWidth, compute, LINE_GAP, LINE_H, screenWidget, strWidth, wrapText, type LNode, type LWidget } from "./layout";
import { widgetProperties } from "./properties";
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
import "./ScreenDesigner.css";

/** What Properties shows for the designer's selection (`setSelection` kind `"yui.widget"`). */
export interface YuiSelectionData {
  path: string;
  objectName: string;
  objectType: string;
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
const ZOOMS = [1, 2, 3, 4];
const GRID = 2;

interface Session {
  text: string;
  doc: YuiDoc;
  past: YuiDoc[];
  future: YuiDoc[];
  selection: string[];
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
  widget: LWidget;
}

function collect(widget: LWidget, node: LNode, out: Map<string, Geo>) {
  const p = widget.style.pad;
  const r = node.rect;
  out.set(widget.uid, { rect: r, content: { x: r.x + p[3], y: r.y + p[0], w: Math.max(0, r.w - p[1] - p[3]), h: Math.max(0, r.h - p[0] - p[2]) }, widget });
  widget.children.forEach((c, i) => node.children[i] && collect(c, node.children[i], out));
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
        const session: Session = { text: serializeYui(doc), doc, past: [], future: [], selection: [] };
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
        const session: Session = { text, doc, past: [], future: [], selection: [] };
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
      if (link) {
        const text = link.write(s.doc, next);
        if (text === null) return;
        s.text = text;
      } else {
        s.past.push(s.doc);
        if (s.past.length > 200) s.past.shift();
        s.future = [];
        // Only what changed is rewritten — the rest of the file stays as the user wrote it.
        s.text = patchYui(s.text, s.doc, next);
        onChange(s.text);
      }
      s.doc = next;
      if (nextSelection) s.selection = nextSelection;
      s.selection = s.selection.filter((uid) => findNode(next.root, uid));
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
      const doc = from.pop();
      if (!doc) return;
      to.push(s.doc);
      s.text = patchYui(s.text, s.doc, doc);
      s.doc = doc;
      s.selection = s.selection.filter((uid) => findNode(doc.root, uid));
      onChange(s.text);
      setRevision((r) => r + 1);
      notifyDocumentCommands();
    },
    [onChange, readOnly, link]
  );

  // ── Layout ────────────────────────────────────────────────────────────────

  const res = RESOLUTIONS[view.res] ?? RESOLUTIONS[0];
  const layout = useMemo(() => {
    if (!doc) return null;
    const widget = screenWidget(doc.root, res.w, res.h);
    const tree = compute(widget, res.w, res.h);
    const geo = new Map<string, Geo>();
    collect(widget, tree, geo);
    return { widget, tree, geo };
  }, [doc, res.w, res.h]);

  const items = useMemo<DesignItem[]>(() => {
    if (!doc || !layout) return [];
    const out: DesignItem[] = [];
    const visit = (n: YuiNode, parent: YuiNode | null) => {
      const g = layout.geo.get(n.uid);
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
      if (isContainer(n)) n.children.forEach((c) => visit(c, n));
    };
    visit(doc.root, null);
    return out;
  }, [doc, layout]);

  // ── Edits ─────────────────────────────────────────────────────────────────

  /** The container a new/pasted widget goes into: the selected container, else the selection's container, else the screen. */
  const insertionTarget = (d: YuiDoc, sel: string[]): YuiNode => {
    const primary = sel[0] ? findNode(d.root, sel[0]) : null;
    if (primary && isContainer(primary)) return primary;
    return (primary && findParent(d.root, primary.uid)) || d.root;
  };

  /** Index among `container`'s children where something dropped at `point` goes (flow containers). */
  const flowIndex = (container: YuiNode, point: DesignPoint, skip: ReadonlySet<string>): number => {
    const row = container.kind === "Row";
    let index = 0;
    for (const c of container.children) {
      if (skip.has(c.uid)) continue;
      const g = layout?.geo.get(c.uid);
      if (g && c.attrs.x === undefined && c.attrs.y === undefined) {
        const mid = row ? g.rect.x + g.rect.w / 2 : g.rect.y + g.rect.h / 2;
        if ((row ? point.x : point.y) < mid) return index;
      }
      index++;
    }
    return index;
  };

  const placeNew = (d: YuiDoc, node: YuiNode, target: YuiNode, point: DesignPoint | null): YuiDoc => {
    const content = layout?.geo.get(target.uid)?.content;
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

  const addWidget = (kind: YuiKind, point: DesignPoint | null = null, targetUid: string | null = null) => {
    const s = sessionRef.current;
    if (!s || kind === "Screen") return;
    const target = (targetUid && findNode(s.doc.root, targetUid)) || (point ? s.doc.root : insertionTarget(s.doc, s.selection));
    const node = newNode(kind);
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
    let d = s.doc;
    const added: string[] = [];
    for (const n of nodes) {
      if (!(KINDS as readonly string[]).includes(n.kind) || n.kind === "Screen") continue;
      const copy = cloneFresh(n);
      const x = Number(copy.attrs.x ?? 0);
      const y = Number(copy.attrs.y ?? 0);
      const into = findNode(d.root, target.uid)!;
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
    if (!s || !layout) return;
    let d = s.doc;
    for (const uid of movable(d, s.selection)) {
      const parent = findParent(d.root, uid)!;
      const node = findNode(d.root, uid)!;
      const g = layout.geo.get(uid);
      if (!g) continue;
      if (resize) {
        d = { ...d, root: mapNode(d.root, uid, (n) => withAttrs(n, { w: round(Math.max(1, g.rect.w + dx)), h: round(Math.max(1, g.rect.h + dy)) })) };
      } else if (positioned(node, parent)) {
        const pc = layout.geo.get(parent.uid)!.content;
        d = { ...d, root: mapNode(d.root, uid, (n) => withAttrs(n, { x: round(g.rect.x - pc.x + dx), y: round(g.rect.y - pc.y + dy) })) };
      } else {
        const index = parent.children.findIndex((c) => c.uid === uid);
        const to = index + Math.sign(dx + dy);
        if (to < 0 || to >= parent.children.length) continue;
        d = { ...d, root: removeNodes(d.root, new Set([uid])) };
        d = { ...d, root: insertNodes(d.root, parent.uid, to, [node]) };
      }
    }
    // A resized screen: its own width/height.
    if (resize && s.selection[0] === d.root.uid && layout.geo.get(d.root.uid)) {
      const g = layout.geo.get(d.root.uid)!;
      d = { ...d, root: withAttrs(d.root, { width: round(Math.max(1, g.rect.w + dx)), height: round(Math.max(1, g.rect.h + dy)) }) };
    }
    commit(d);
  };

  const onCommit = (change: DesignChange) => {
    const s = sessionRef.current;
    if (!s || !layout) return;
    let d = s.doc;
    if (change.kind === "resize") {
      const node = findNode(d.root, change.id);
      if (!node) return;
      const r = change.rect;
      if (node.uid === d.root.uid) {
        commit({ ...d, root: withAttrs(d.root, { width: round(r.w), height: round(r.h) }) });
        return;
      }
      const parent = findParent(d.root, node.uid)!;
      const changes: Record<string, string> = { w: round(r.w), h: round(r.h) };
      if (positioned(node, parent)) {
        const pc = layout.geo.get(parent.uid)!.content;
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
    const target = findNode(d.root, targetUid)!;
    const stayFree = ids.every((uid) => findParent(d.root, uid)?.uid === targetUid && positioned(findNode(d.root, uid)!, target));
    if (isCanvas(target) || stayFree) {
      const content = layout.geo.get(targetUid)!.content;
      for (const uid of ids) {
        const r = change.rects[uid];
        if (!r) continue;
        const moved = withAttrs(findNode(d.root, uid)!, { x: round(r.x - content.x), y: round(r.y - content.y) });
        if (findParent(d.root, uid)?.uid === targetUid) d = { ...d, root: mapNode(d.root, uid, () => moved) };
        else {
          d = { ...d, root: removeNodes(d.root, new Set([uid])) };
          const into = findNode(d.root, targetUid)!;
          d = { ...d, root: insertNodes(d.root, targetUid, into.children.length, [moved]) };
        }
      }
    } else {
      const nodes = ids.map((uid) => withAttrs(findNode(d.root, uid)!, { x: undefined, y: undefined }));
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

  const publish = () => {
    const s = sessionRef.current;
    if (!s) return;
    const uids = s.selection.length ? s.selection : [s.doc.root.uid];
    const nodes = uids.map((uid) => findNode(s.doc.root, uid)).filter((n): n is YuiNode => !!n);
    const first = nodes[0];
    if (!first) return;
    const data: YuiSelectionData = {
      path,
      objectName: nodes.length > 1 ? tn(nodes.length, "{count} widget", "{count} widgets", { count: nodes.length }) : (first.attrs.id ?? ""),
      objectType: nodes.length > 1 ? "" : t(KIND_INFO[first.kind as YuiKind]?.label ?? first.kind),
      objectKey: `${path}#${uids.join(",")}`,
      properties: widgetProperties(nodes, applyAttr),
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
            // Same nodes, same uids: the selection survives the re-parse.
            s.doc = { ...doc, root: adoptUids(s.doc.root, doc.root) };
            s.text = text;
            s.selection = s.selection.filter((uid) => findNode(s.doc.root, uid));
          } else {
            const session: Session = { text, doc, past: [], future: [], selection: [] };
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

  const focused = () => {
    const el = document.activeElement;
    return !!el && el.classList.contains("sp-design-surface") && !!canvasRef.current?.contains(el);
  };
  const editable = () => focused() && !readOnly;
  const keyOpts = { when: editable };
  useKeybinding(["Delete"], () => commands.current.deleteSelection(), keyOpts);
  useKeybinding("Ctrl+Z", () => commands.current.step(true), keyOpts);
  useKeybinding(["Ctrl+Y", "Ctrl+Shift+Z"], () => commands.current.step(false), keyOpts);
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
  const primaryGeo = primary ? layout.geo.get(primary.uid) : undefined;

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
        <span className="yui-designer-status">
          {primary && primaryGeo
            ? `${nodeLabel(primary)} · ${Math.round(primaryGeo.rect.x)}, ${Math.round(primaryGeo.rect.y)} · ${Math.round(primaryGeo.rect.w)} × ${Math.round(primaryGeo.rect.h)}`
            : doc.root.attrs.id}
        </span>
      </div>
      <div className="yui-designer-canvas" ref={canvasRef}>
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
                    if ((KINDS as readonly string[]).includes(kind)) addWidget(kind as YuiKind, point, target ?? doc.root.uid);
                    setTimeout(() => publishRef.current());
                  },
                }
          }
          onContextMenu={(e) => menu.openAtPoint(undefined, e)}
        >
          <div className="yui-world" />
          <McWidget widget={layout.widget} node={layout.tree} zoom={view.zoom} />
        </DesignSurface>
      </div>
      <ContextMenu target={menu.target ? { mode: "viewport", x: menu.target.mode === "viewport" ? menu.target.x : 0, y: menu.target.mode === "viewport" ? menu.target.y : 0 } : null} items={contextItems} onClose={menu.close} />
    </div>
  );
}

// ── Minecraft-like rendering (mirrors `render.rs`) ────────────────────────────

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
  const r = node.rect;
  const s = widget.style;
  const parts: ReactNode[] = [];
  if (widget.uid !== "" && (s.bg >>> 24) !== 0) parts.push(<div key="bg" className="yui-box" style={{ ...box(r, zoom), background: cssColor(s.bg) }} />);
  const outline = widget.uid !== "" && (widget.kind === "panel" || widget.kind === "spacer");
  if (outline) parts.push(<div key="outline" className="yui-box yui-outline" style={box(r, zoom)} />);

  if (widget.kind === "label" || widget.kind === "button") {
    const availW = Math.max(0, r.w - s.pad[1] - s.pad[3]);
    const lines = s.noWrap ? [widget.text] : wrapText(widget.text, availW, s.fontScale);
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
      <div key="img" className="yui-box yui-image" style={box({ x: r.x + s.pad[3], y: r.y + s.pad[0], w: Math.max(0, r.w - s.pad[1] - s.pad[3]), h: Math.max(0, r.h - s.pad[0] - s.pad[2]) }, zoom)} title={widget.texture}>
        <span style={{ fontSize: 6 * zoom }}>{widget.texture.split("/").pop()}</span>
      </div>
    );
  }
  widget.children.forEach((c, i) => node.children[i] && parts.push(<McWidget key={c.uid || i} widget={c} node={node.children[i]} zoom={zoom} />));
  return <>{parts}</>;
}
