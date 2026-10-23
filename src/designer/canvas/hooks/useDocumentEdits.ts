// The document and selection, and committing an edit (an undo step) or a selection.

import { useCallback } from "react";
import { notifyDocumentCommands } from "substrate-platform-ui";
import type { ScreenDesignerProps } from "../../view/ScreenDesigner";
import { findNode, type YuiDoc } from "../../model/yui";
import { patchYui } from "../../model/yuiText";
import { rememberSelection } from "../designerModel";
import type { DesignerState } from "./useDesignerState";

/** The document and selection, and committing an edit (an undo step) or a selection. */
export function useDocumentEdits(props: ScreenDesignerProps, designerState: DesignerState) {
  const { onChange, readOnly, link } = props;
  const { setRevision, sessionRef } = designerState;
  const session = sessionRef.current;
  const doc = session?.doc ?? null;
  const selection = session?.selection ?? [];

  const commit = useCallback(
    (next: YuiDoc, nextSelection?: string[]) => {
      const s = sessionRef.current;
      if (!s || readOnly || next === s.doc) return;
      const before = s.text;
      rememberSelection(s, before, s.doc, s.selection);
      if (link) {
        const text = link.write(s.doc, next);
        if (text === null) return;
        s.text = text;
      } else {
        // Only what changed is rewritten — the rest of the file stays as the
        // user wrote it. Undo is the platform's history of the text.
        s.text = patchYui(s.text, s.doc, next);
        onChange(s.text);
      }
      s.doc = next;
      if (nextSelection) s.selection = nextSelection;
      s.selection = s.selection.filter((uid) => findNode(next.root, uid));
      rememberSelection(s, s.text, next, s.selection);
      setRevision((r) => r + 1);
      notifyDocumentCommands();
    },
    [onChange, readOnly, link]
  );

  const select = useCallback((uids: string[]) => {
    const s = sessionRef.current;
    if (!s) return;
    s.selection = uids;
    setRevision((r) => r + 1);
    notifyDocumentCommands();
  }, []);

  return { session, doc, selection, commit, select };
}

/** What `useDocumentEdits` gives. */
export type DocumentEdits = ReturnType<typeof useDocumentEdits>;
