// How the screen lays out, and the real picture the game draws of it.

import type { DesignerDocument } from "./useDesignerDocument";
import type { ScreenDesignerProps } from "../ScreenDesigner";
import { useDesignerLayout } from "./hooks/useDesignerLayout";
import { useRenderedPicture } from "./hooks/useRenderedPicture";
import { useDesignItems } from "./hooks/useDesignItems";

/** How the screen lays out, and the real picture the game draws of it. */
export function useDesignerPicture(props: ScreenDesignerProps, designerDocument: DesignerDocument) {
  const designerLayout = useDesignerLayout(props, designerDocument);
  const renderedPicture = useRenderedPicture(props, designerDocument, designerLayout);
  const designItems = useDesignItems(designerDocument, designerLayout, renderedPicture);
  const { res, resourcesVersion, components, componentsRevision, layout } = designerLayout;
  const { previewing, setPreviewing, previewTexts, setPreviewTexts, focusedBox, setFocusedBox, hovered, setHovered, pressed, setPressed, previewTick, setPreviewTick, lastEvent, setLastEvent, rendered, setRendered, renderError, setRenderError, renderSeq, drawnRoot } = renderedPicture;
  const { picture, geo, items } = designItems;
  return { res, resourcesVersion, components, componentsRevision, layout, previewing, setPreviewing, previewTexts, setPreviewTexts, focusedBox, setFocusedBox, hovered, setHovered, pressed, setPressed, previewTick, setPreviewTick, lastEvent, setLastEvent, rendered, setRendered, renderError, setRenderError, renderSeq, drawnRoot, picture, geo, items };
}

/** What `useDesignerPicture` gives the component. */
export type DesignerPicture = ReturnType<typeof useDesignerPicture>;
