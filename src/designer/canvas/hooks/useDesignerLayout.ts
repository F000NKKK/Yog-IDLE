// The resolution, the mod's texts and components, and the layout drawn without the game.

import { useMemo } from "react";
import { useDesignResources } from "../../../lang/designResources";
import { modRootOf } from "../../../paths";
import type { ScreenDesignerProps } from "../../ScreenDesigner";
import { designRoot, useComponents } from "../../components";
import { compute } from "../../layout";
import { screenWidget } from "../../layoutWidget";
import { collect, type Geo, RESOLUTIONS } from "../designerModel";
import type { DesignerDocument } from "../useDesignerDocument";

/** The resolution, the mod's texts and components, and the layout drawn without the game. */
export function useDesignerLayout(props: ScreenDesignerProps, designerDocument: DesignerDocument) {
  const { path } = props;
  const { view, doc } = designerDocument;
  // ── Layout ────────────────────────────────────────────────────────────────

  const res = RESOLUTIONS[view.res] ?? RESOLUTIONS[0];
  // `@Strings.title` texts shown from the mod's .yres files (docs/yres.md).
  const resourcesVersion = useDesignResources(modRootOf(path));
  // The mod's components (docs/yui.md, "Components"): what instances draw as, re-drawn when one changes.
  const components = useComponents(path);
  const componentsRevision = components ? `${components.revision}:${components.status}` : "";
  const layout = useMemo(() => {
    if (!doc) return null;
    const widget = screenWidget(designRoot(doc.root), res.w, res.h);
    const tree = compute(widget, res.w, res.h);
    const geo = new Map<string, Geo>();
    collect(widget, tree, geo);
    return { widget, tree, geo };
  }, [doc, res.w, res.h, resourcesVersion]);

  return { res, resourcesVersion, components, componentsRevision, layout };
}

/** What `useDesignerLayout` gives. */
export type DesignerLayout = ReturnType<typeof useDesignerLayout>;
