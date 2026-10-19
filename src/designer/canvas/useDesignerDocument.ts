// The designer's document: its tree, the edit session, selection, history and view settings.

import type { ScreenDesignerProps } from "../ScreenDesigner";
import { useDesignerState } from "./hooks/useDesignerState";
import { useDocumentLoading } from "./hooks/useDocumentLoading";
import { useDocumentEdits } from "./hooks/useDocumentEdits";

/** The designer's document: its tree, the edit session, selection, history and view settings. */
export function useDesignerDocument(props: ScreenDesignerProps) {
  const designerState = useDesignerState(props);
  const documentLoading = useDocumentLoading(props, designerState);
  const documentEdits = useDocumentEdits(props, designerState);
  const { t, activeTab, isActive, canvasRef, view, setView, setRevision, error, setError, sessionRef, draggingRef, fromTextRef, menu, railMenu, setRailMenu } = designerState;
  const { load, loadedVersion } = documentLoading;
  const { session, doc, selection, commit, select } = documentEdits;
  return { t, activeTab, isActive, canvasRef, view, setView, setRevision, error, setError, sessionRef, draggingRef, fromTextRef, menu, railMenu, setRailMenu, load, loadedVersion, session, doc, selection, commit, select };
}

/** What `useDesignerDocument` gives the component. */
export type DesignerDocument = ReturnType<typeof useDesignerDocument>;
