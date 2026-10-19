// Bringing the selection to the front or back, and nudging it.

import { cellAttrs, cellOf, gridDefs } from "../../grid";
import { findNode, findParent, insertNodes, isGrid, mapNode, removeNodes, withAttrs } from "../../yui";
import { positioned, round } from "../designerModel";
import type { DesignerDocument } from "../useDesignerDocument";
import type { DesignerPicture } from "../useDesignerPicture";
import type { ClipboardEdits } from "./useClipboardEdits";

/** Bringing the selection to the front or back, and nudging it. */
export function useArrange(designerDocument: DesignerDocument, designerPicture: DesignerPicture, clipboardEdits: ClipboardEdits) {
  const { sessionRef, commit } = designerDocument;
  const { geo } = designerPicture;
  const { movable } = clipboardEdits;
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

  return { reorder, nudge };
}

/** What `useArrange` gives. */
export type Arrange = ReturnType<typeof useArrange>;
