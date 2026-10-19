// Event handlers: opening (or creating) a handler in the code-behind.

import { useRef } from "react";
import { openFile, reportError } from "substrate-platform-ui";
import { cli } from "../../../cli";
import { emitTo, EVENT } from "../../../events";
import type { ScreenDesignerProps } from "../../ScreenDesigner";
import { findNode, mapNode, withAttrs } from "../../yui";
import { type HandlerLocation, newEventName } from "../designerModel";
import type { DesignerDocument } from "../useDesignerDocument";

/** Event handlers: opening (or creating) a handler in the code-behind. */
export function useHandlerOpening(props: ScreenDesignerProps, designerDocument: DesignerDocument) {
  const { path, readOnly } = props;
  const { t, sessionRef, commit } = designerDocument;
  // ── Event handlers (code-behind) ──────────────────────────────────────────

  /**
   * As in Visual Studio: the handler of `node`'s `attr` event in the
   * screen's code-behind `.rs` — the event named first if it has none
   * (`<id>_click`), the handler added if missing — opened at its body.
   */
  const openHandler = async (uid: string, attr: string, name?: string) => {
    const s = sessionRef.current;
    const node = s ? findNode(s.doc.root, uid) : null;
    if (!s || !node) return;
    let event = node.attrs[attr];
    if (!event) {
      if (readOnly) return;
      event = name ?? newEventName(s.doc.root, node, attr);
      const before = s.doc;
      commit({ ...s.doc, root: mapNode(s.doc.root, uid, (n) => withAttrs(n, { [attr]: event })) });
      if (s.doc === before) return; // not written (the XAML can't take it now)
    }
    try {
      const at = await cli<HandlerLocation>("yui_event_handler", { path, event });
      openFile({ path: at.path, line: at.line, column: at.column });
      if (at.changed) emitTo(EVENT.ideOutput, `[designer] ${t("Added handler for {event} to {file}", { event, file: at.path })}`);
    } catch (err) {
      reportError(t("Couldn't open the handler for {event}: {error}", { event, error: String(err instanceof Error ? err.message : err) }));
    }
  };
  const openHandlerRef = useRef(openHandler);
  openHandlerRef.current = openHandler;

  return { openHandler, openHandlerRef };
}

/** What `useHandlerOpening` gives. */
export type HandlerOpening = ReturnType<typeof useHandlerOpening>;
