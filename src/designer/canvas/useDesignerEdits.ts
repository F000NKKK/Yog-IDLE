// Edits to the screen: adding, moving, resizing, deleting, copying and pasting widgets.

import type { DesignerDocument } from "./useDesignerDocument";
import type { DesignerPicture } from "./useDesignerPicture";
import { useInsertion } from "./edits/useInsertion";
import { useWidgetAdding } from "./edits/useWidgetAdding";
import { useClipboardEdits } from "./edits/useClipboardEdits";
import { useArrange } from "./edits/useArrange";
import { useCanvasCommit } from "./edits/useCanvasCommit";
import { useAttrEdits } from "./edits/useAttrEdits";

/** Edits to the screen: adding, moving, resizing, deleting, copying and pasting widgets. */
export function useDesignerEdits(designerDocument: DesignerDocument, designerPicture: DesignerPicture) {
  const insertion = useInsertion(designerDocument, designerPicture);
  const widgetAdding = useWidgetAdding(designerDocument, designerPicture, insertion);
  const clipboardEdits = useClipboardEdits(designerDocument, insertion);
  const arrange = useArrange(designerDocument, designerPicture, clipboardEdits);
  const canvasCommit = useCanvasCommit(designerDocument, designerPicture, insertion);
  const attrEdits = useAttrEdits(designerDocument);
  const { intoTarget, insertionTarget, addable, flowIndex, gridGeo } = insertion;
  const { placeNew, addWidget } = widgetAdding;
  const { movable, deleteSelection, copySelection, paste, duplicate } = clipboardEdits;
  const { reorder, nudge } = arrange;
  const { onCommit } = canvasCommit;
  const { applyAttr } = attrEdits;
  return { intoTarget, insertionTarget, addable, flowIndex, gridGeo, placeNew, addWidget, movable, deleteSelection, copySelection, paste, duplicate, reorder, nudge, onCommit, applyAttr };
}

/** What `useDesignerEdits` gives the component. */
export type DesignerEdits = ReturnType<typeof useDesignerEdits>;
