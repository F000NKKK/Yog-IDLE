// Pasting widgets, and duplicating the selection.

import { componentBody, isComponentDoc } from "../../model/components";
import { cloneFresh, findNode, findParent, insertNodes, isCanvas, parseNodes, withAttrs } from "../../model/yui";
import { clipboard, fitParent, positioned, round } from "../designerModel";
import type { DesignerDocument } from "../useDesignerDocument";
import type { Insertion } from "./useInsertion";
import type { SelectionRemoval } from "./useSelectionRemoval";

/** Pasting widgets, and duplicating the selection. */
export function usePasting(designerDocument: DesignerDocument, insertion: Insertion, selectionRemoval: SelectionRemoval) {
  const { sessionRef, commit } = designerDocument;
  const { insertionTarget, addable } = insertion;
  const { movable } = selectionRemoval;
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

  return { paste, duplicate };
}

/** What `usePasting` gives. */
export type Pasting = ReturnType<typeof usePasting>;
