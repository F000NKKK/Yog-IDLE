// Deleting, copying, pasting and duplicating the selection.

import type { DesignerDocument } from "../useDesignerDocument";
import type { Insertion } from "./useInsertion";
import { useSelectionRemoval } from "./useSelectionRemoval";
import { usePasting } from "./usePasting";

/** Deleting, copying, pasting and duplicating the selection. */
export function useClipboardEdits(designerDocument: DesignerDocument, insertion: Insertion) {
  const selectionRemoval = useSelectionRemoval(designerDocument);
  const pasting = usePasting(designerDocument, insertion, selectionRemoval);
  const { movable, deleteSelection, copySelection } = selectionRemoval;
  const { paste, duplicate } = pasting;
  return { movable, deleteSelection, copySelection, paste, duplicate };
}

/** What `useClipboardEdits` gives. */
export type ClipboardEdits = ReturnType<typeof useClipboardEdits>;
