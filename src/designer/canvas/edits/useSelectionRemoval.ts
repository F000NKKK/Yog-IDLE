// The selection's widgets that can move, deleted or copied.

import { notifyDocumentCommands } from "substrate-platform-ui";
import { findNode, findParent, isDescendant, removeNodes, serializeNodes, type YuiDoc } from "../../model/yui";
import { setClipboard } from "../designerModel";
import type { DesignerDocument } from "../useDesignerDocument";

/** The selection's widgets that can move, deleted or copied. */
export function useSelectionRemoval(designerDocument: DesignerDocument) {
  const { sessionRef, commit } = designerDocument;
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
    const text = serializeNodes(nodes);
    setClipboard(text);
    navigator.clipboard?.writeText(text).catch(() => {});
    notifyDocumentCommands();
    return true;
  };

  return { movable, deleteSelection, copySelection };
}

/** What `useSelectionRemoval` gives. */
export type SelectionRemoval = ReturnType<typeof useSelectionRemoval>;
