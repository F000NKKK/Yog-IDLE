// A move or resize on the canvas, written into the document.

import type { DesignChange } from "substrate-platform-ui";
import type { DesignerDocument } from "../useDesignerDocument";
import type { DesignerPicture } from "../useDesignerPicture";
import { moved, resized } from "./canvasMoves";
import type { Insertion } from "./useInsertion";

/** A move or resize on the canvas, written into the document. */
export function useCanvasCommit(designerDocument: DesignerDocument, designerPicture: DesignerPicture, insertion: Insertion) {
  const { sessionRef, commit } = designerDocument;
  const { geo } = designerPicture;
  const onCommit = (change: DesignChange) => {
    const s = sessionRef.current;
    if (!s || !geo) return;
    const next = change.kind === "resize" ? resized(s.doc, change, geo) : moved(s.doc, change, { geo, insertion });
    if (next) commit(next);
  };
  return { onCommit };
}

/** What `useCanvasCommit` gives. */
export type CanvasCommit = ReturnType<typeof useCanvasCommit>;
