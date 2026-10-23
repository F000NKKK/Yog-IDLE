// What the canvas shows and picks: the picture or the stand-in, and the items over it.

import { useMemo } from "react";
import type { DesignItem } from "substrate-platform-ui";
import { isComponentDoc } from "../../model/components";
import { isContainer, type YuiNode } from "../../model/yui";
import { nodeLabel, positioned } from "../designerModel";
import type { DesignerDocument } from "../useDesignerDocument";
import type { DesignerLayout } from "./useDesignerLayout";
import type { RenderedPicture } from "./useRenderedPicture";

/** What the canvas shows and picks: the picture or the stand-in, and the items over it. */
export function useDesignItems(designerDocument: DesignerDocument, designerLayout: DesignerLayout, renderedPicture: RenderedPicture) {
  const { doc } = designerDocument;
  const { res, layout } = designerLayout;
  const { rendered } = renderedPicture;
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

  return { picture, geo, items };
}

/** What `useDesignItems` gives. */
export type DesignItems = ReturnType<typeof useDesignItems>;
