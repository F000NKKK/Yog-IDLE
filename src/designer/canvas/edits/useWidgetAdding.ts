// Adding a widget: placed at a point, or into the selection's container.

import type { DesignPoint } from "substrate-platform-ui";
import { cellAt } from "../../GridAdorner";
import { findComponent } from "../../components";
import { cellAttrs } from "../../grid";
import { findNode, insertNodes, isCanvas, isGrid, mapNode, newNode, withAttrs, type YuiDoc, type YuiNode } from "../../yui";
import { clampCells, fitParent, round } from "../designerModel";
import type { DesignerDocument } from "../useDesignerDocument";
import type { DesignerPicture } from "../useDesignerPicture";
import type { Insertion } from "./useInsertion";

/** Adding a widget: placed at a point, or into the selection's container. */
export function useWidgetAdding(designerDocument: DesignerDocument, designerPicture: DesignerPicture, insertion: Insertion) {
  const { sessionRef, commit } = designerDocument;
  const { components, geo } = designerPicture;
  const { intoTarget, insertionTarget, addable, flowIndex, gridGeo } = insertion;
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

  return { placeNew, addWidget };
}

/** What `useWidgetAdding` gives. */
export type WidgetAdding = ReturnType<typeof useWidgetAdding>;
