// Where something added goes: the container it lands in, whether it can, its place in a flow or grid.

import type { DesignPoint } from "substrate-platform-ui";
import { yui } from "../../../data/yogIds.generated";
import type { GridGeo } from "../../GridAdorner";
import { componentBody, findComponent, isComponentDoc } from "../../components";
import { findNode, findParent, isContainer, KINDS, type YuiDoc, type YuiNode } from "../../yui";
import type { DesignerDocument } from "../useDesignerDocument";
import type { DesignerPicture } from "../useDesignerPicture";

/** Where something added goes: the container it lands in, whether it can, its place in a flow or grid. */
export function useInsertion(designerDocument: DesignerDocument, designerPicture: DesignerPicture) {
  const { sessionRef } = designerDocument;
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

  return { intoTarget, insertionTarget, addable, flowIndex, gridGeo };
}

/** What `useInsertion` gives. */
export type Insertion = ReturnType<typeof useInsertion>;
