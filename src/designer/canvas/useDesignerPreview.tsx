// The preview: the screen running live, its events, zoom and panning.

import type { DesignerCommands } from "./useDesignerCommands";
import type { DesignerDocument } from "./useDesignerDocument";
import type { DesignerPicture } from "./useDesignerPicture";
import type { ScreenDesignerProps } from "../view/ScreenDesigner";
import { usePreviewEvents } from "./hooks/usePreviewEvents";
import { usePreviewInput } from "./hooks/usePreviewInput";
import { useDesignerKeys } from "./hooks/useDesignerKeys";
import { useViewZoom } from "./hooks/useViewZoom";

/** The preview: the screen running live, its events, zoom and panning. */
export function useDesignerPreview(props: ScreenDesignerProps, designerDocument: DesignerDocument, designerPicture: DesignerPicture, designerCommands: DesignerCommands) {
  const previewEvents = usePreviewEvents(props, designerPicture);
  const previewInput = usePreviewInput(designerDocument, designerPicture, previewEvents);
  const designerKeys = useDesignerKeys(props, designerDocument, designerCommands);
  const viewZoom = useViewZoom(designerDocument, designerPicture);
  const { pageRef, drawnRef, eventBusy, queuedMove, fired, sendEvent, sendEventRef, togglePreview } = previewEvents;
  const { guiPoint, fmt, textBoxAt, typeInto, onPreviewKey } = previewInput;
  const { focused, editable, keyOpts, ARROWS } = designerKeys;
  const { updateView, zoomRef, hasCanvas } = viewZoom;
  return { pageRef, drawnRef, eventBusy, queuedMove, fired, sendEvent, sendEventRef, togglePreview, guiPoint, fmt, textBoxAt, typeInto, onPreviewKey, focused, editable, keyOpts, ARROWS, updateView, zoomRef, hasCanvas };
}

/** What `useDesignerPreview` gives the component. */
export type DesignerPreview = ReturnType<typeof useDesignerPreview>;
