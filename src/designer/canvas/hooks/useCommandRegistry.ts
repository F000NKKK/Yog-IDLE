// The Edit menu's and Toolbox's commands, registered for this document.

import { useEffect, useRef } from "react";
import { registerDocumentCommands } from "substrate-platform-ui";
import type { ScreenDesignerProps } from "../../view/ScreenDesigner";
import { clipboard } from "../designerModel";
import type { DesignerDocument } from "../useDesignerDocument";
import type { DesignerEdits } from "../useDesignerEdits";

/** The Edit menu's and Toolbox's commands, registered for this document. */
export function useCommandRegistry(props: ScreenDesignerProps, designerDocument: DesignerDocument, designerEdits: DesignerEdits) {
  const { path, readOnly, link } = props;
  const { sessionRef, select } = designerDocument;
  const { addWidget, movable, deleteSelection, copySelection, paste, duplicate, reorder, nudge } = designerEdits;
  // ── Commands (Edit menu, Toolbox, keys) ───────────────────────────────────

  const commands = useRef({ deleteSelection, copySelection, paste, duplicate, addWidget, select, reorder, nudge });
  commands.current = { deleteSelection, copySelection, paste, duplicate, addWidget, select, reorder, nudge };

  useEffect(
    () =>
      registerDocumentCommands(path, {
        hasSelection: () => {
          const s = sessionRef.current;
          return !!s && movable(s.doc, s.selection).length > 0;
        },
        cut: () => commands.current.copySelection() && commands.current.deleteSelection(),
        copy: () => void commands.current.copySelection(),
        canPaste: () => !readOnly && !!clipboard,
        paste: () => commands.current.paste(),
        selectAll: () => {
          const s = sessionRef.current;
          if (s) commands.current.select(s.doc.root.children.map((c) => c.uid));
        },
        delete: () => commands.current.deleteSelection(),
        preferred: link?.preferred,
      }),
    [path, readOnly, link]
  );

  return { commands };
}

/** What `useCommandRegistry` gives. */
export type CommandRegistry = ReturnType<typeof useCommandRegistry>;
