// An attribute set from Properties.

import { mapNode, withAttrs, type YuiNode } from "../../model/yui";
import type { DesignerDocument } from "../useDesignerDocument";

/** An attribute set from Properties. */
export function useAttrEdits(designerDocument: DesignerDocument) {
  const { t, sessionRef, commit } = designerDocument;
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

  return { applyAttr };
}

/** What `useAttrEdits` gives. */
export type AttrEdits = ReturnType<typeof useAttrEdits>;
