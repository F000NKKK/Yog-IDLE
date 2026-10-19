// A canvas change applied to the document: a resize, or widgets moved —
// into a grid's cells, freely onto a canvas, or into a flow.

import type { DesignChange } from "substrate-platform-ui";
import { cellAt } from "../../GridAdorner";
import { isComponentDoc } from "../../components";
import { cellAttrs } from "../../grid";
import { findNode, findParent, insertNodes, isCanvas, isDescendant, isGrid, mapNode, removeNodes, withAttrs, type YuiDoc, type YuiNode } from "../../yui";
import type { DesignerPicture } from "../useDesignerPicture";
import { clampCells, fitParent, positioned, round } from "../designerModel";
import type { Insertion } from "./useInsertion";

type Geo = NonNullable<DesignerPicture["geo"]>;
type Resize = Extract<DesignChange, { kind: "resize" }>;
type Move = Exclude<DesignChange, Resize>;

/** What a move needs besides the document: the layout, and where things added land. */
export interface MoveContext {
  geo: Geo;
  insertion: Insertion;
}

/** A node resized: the root's size (a component's design size), or a widget's size — and position, where it's positioned. */
export function resized(d: YuiDoc, change: Resize, geo: Geo): YuiDoc | null {
  const node = findNode(d.root, change.id);
  if (!node) return null;
  const r = change.rect;
  if (node.uid === d.root.uid) {
    const [wk, hk] = isComponentDoc(d.root) ? ["design_w", "design_h"] : ["width", "height"];
    return { ...d, root: withAttrs(d.root, { [wk]: round(r.w), [hk]: round(r.h) }) };
  }
  const parent = findParent(d.root, node.uid);
  const changes: Record<string, string> = { w: round(r.w), h: round(r.h) };
  const pc = parent && positioned(node, parent) ? geo.get(parent.uid)?.content : undefined;
  if (pc) {
    changes.x = round(r.x - pc.x);
    changes.y = round(r.y - pc.y);
  }
  return { ...d, root: mapNode(d.root, node.uid, (n) => withAttrs(n, changes)) };
}

/** Where moved widgets go: the drop target, unless it's one of them (or inside one) — then where the first of them is. */
function moveTarget(d: YuiDoc, ids: string[], change: Move, { intoTarget }: Insertion): string | null {
  const lead = findParent(d.root, ids[0]);
  if (!lead) return null;
  let targetUid = change.target ?? lead.uid;
  if (ids.some((uid) => uid === targetUid || isDescendant(d.root, uid, targetUid)) || !findNode(d.root, targetUid)) targetUid = lead.uid;
  // A component has one body: what's dropped onto its root goes into the body.
  if (targetUid === d.root.uid && isComponentDoc(d.root) && !ids.every((uid) => findParent(d.root, uid)?.uid === d.root.uid)) {
    const into = intoTarget(d, d.root);
    targetUid = into && into.uid !== d.root.uid ? into.uid : lead.uid;
  }
  return targetUid;
}

/** `moved` (the widget `uid`, changed) put in `targetUid`: in place if it's already there, else taken out and appended. */
function placed(d: YuiDoc, uid: string, targetUid: string, moved: YuiNode): YuiDoc {
  if (findParent(d.root, uid)?.uid === targetUid) return { ...d, root: mapNode(d.root, uid, () => moved) };
  const root = removeNodes(d.root, new Set([uid]));
  const into = findNode(root, targetUid);
  return { ...d, root: insertNodes(root, targetUid, into?.children.length ?? 0, [moved]) };
}

/** Into the cell under the pointer — each widget of a group at its own offset from the lead's. */
function intoGrid(d: YuiDoc, ids: string[], targetUid: string, change: Move, { insertion }: MoveContext): YuiDoc {
  const gg = insertion.gridGeo(targetUid);
  const lead = change.rects[ids[0]];
  for (const uid of ids) {
    const node = findNode(d.root, uid);
    if (!node) continue;
    const r = change.rects[uid];
    const [row, col] = gg && r && lead ? cellAt(gg, change.point.x + r.x - lead.x, change.point.y + r.y - lead.y) : [0, 0];
    d = placed(d, uid, targetUid, withAttrs(node, { x: undefined, y: undefined, ...cellAttrs(row, col) }));
  }
  return { ...d, root: mapNode(d.root, targetUid, clampCells) };
}

/** Freely onto a canvas (or staying free where they are): at the dropped positions. */
function freely(d: YuiDoc, ids: string[], target: YuiNode, change: Move, { geo }: MoveContext): YuiDoc {
  const content = geo.get(target.uid)?.content;
  if (!content) return d;
  for (const uid of ids) {
    const node = findNode(d.root, uid);
    const r = change.rects[uid];
    if (!node || !r) continue;
    d = placed(d, uid, target.uid, fitParent(withAttrs(node, { x: round(r.x - content.x), y: round(r.y - content.y) }), target));
  }
  return d;
}

/** Into a flow, at the place under the pointer. */
function intoFlow(d: YuiDoc, ids: string[], target: YuiNode, change: Move, { insertion }: MoveContext): YuiDoc {
  const nodes = ids.flatMap((uid) => {
    const node = findNode(d.root, uid);
    return node ? [fitParent(withAttrs(node, { x: undefined, y: undefined }), target)] : [];
  });
  const index = insertion.flowIndex(target, change.point, new Set(ids));
  const root = removeNodes(d.root, new Set(ids));
  return { ...d, root: insertNodes(root, target.uid, index, nodes) };
}

/** Widgets moved by a drag: into a grid's cells, freely, or into a flow — by what they're dropped on. */
export function moved(d: YuiDoc, change: Move, ctx: MoveContext): YuiDoc | null {
  const ids = change.ids.filter((uid) => uid !== d.root.uid && findNode(d.root, uid));
  if (ids.length === 0) return null;
  const targetUid = moveTarget(d, ids, change, ctx.insertion);
  const target = targetUid ? findNode(d.root, targetUid) : null;
  if (!targetUid || !target) return null;
  const stayFree = ids.every((uid) => {
    const node = findNode(d.root, uid);
    return findParent(d.root, uid)?.uid === targetUid && !!node && positioned(node, target);
  });
  if (isGrid(target) && !stayFree) return intoGrid(d, ids, targetUid, change, ctx);
  if (isCanvas(target) || stayFree) return freely(d, ids, target, change, ctx);
  return intoFlow(d, ids, target, change, ctx);
}
