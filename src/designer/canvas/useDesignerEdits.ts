// Edits to the screen: adding, moving, resizing, deleting, copying and pasting widgets.

import type { DesignerDocument } from "canvas/useDesignerDocument";
import type { DesignerPicture } from "canvas/useDesignerPicture";
import { type DesignChange, type DesignPoint, notifyDocumentCommands } from "substrate-platform-ui";
import { yui } from "../../data/yogIds.generated";
import { cellAt, type GridGeo } from "../GridAdorner";
import { componentBody, findComponent, isComponentDoc } from "../components";
import { cellAttrs, cellOf, gridDefs } from "../grid";
import { cloneFresh, findNode, findParent, insertNodes, isCanvas, isContainer, isDescendant, isGrid, KINDS, mapNode, newNode, parseNodes, removeNodes, serializeNodes, withAttrs, type YuiDoc, type YuiNode } from "../yui";
import { clampCells, clipboard, fitParent, positioned, round, setClipboard } from "./designerModel";
import type { ScreenDesignerProps } from "../ScreenDesigner";

/** Edits to the screen: adding, moving, resizing, deleting, copying and pasting widgets. */
export function useDesignerEdits(props: ScreenDesignerProps, designerDocument: DesignerDocument, designerPicture: DesignerPicture) {
  const { content } = props;
  const { t, sessionRef, commit } = designerDocument;
  const { components, geo } = designerPicture;
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
    if (kind === yui.SCREEN || (root && isComponentDoc(root) && root.attrs.name === kind)) return false;
    return (KINDS as readonly string[]).includes(kind) || !!findComponent(components, kind);
  };

  /** Index among `container`'s children where something dropped at `point` goes (flow containers). */
  const flowIndex = (container: YuiNode, point: DesignPoint, skip: ReadonlySet<string>): number => {
    const row = container.kind === yui.ROW;
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
    setClipboard(serializeNodes(nodes));
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

  return { intoTarget, insertionTarget, addable, flowIndex, gridGeo, placeNew, addWidget, movable, deleteSelection, copySelection, paste, duplicate, reorder, nudge, onCommit, applyAttr };
}

/** What `useDesignerEdits` gives the component. */
export type DesignerEdits = ReturnType<typeof useDesignerEdits>;
