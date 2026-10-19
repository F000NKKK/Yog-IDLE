// The designer's keys: delete, cut/copy/paste, duplicate, reorder, nudge.

import { useKeybinding } from "substrate-platform-ui";
import type { ScreenDesignerProps } from "../../ScreenDesigner";
import { findParent } from "../../yui";
import type { DesignerCommands } from "../useDesignerCommands";
import type { DesignerDocument } from "../useDesignerDocument";

/** The designer's keys: delete, cut/copy/paste, duplicate, reorder, nudge. */
export function useDesignerKeys(props: ScreenDesignerProps, designerDocument: DesignerDocument, designerCommands: DesignerCommands) {
  const { readOnly } = props;
  const { canvasRef, sessionRef, draggingRef } = designerDocument;
  const { commands } = designerCommands;
  const focused = () => {
    const el = document.activeElement;
    return !!el && el.classList.contains("sp-design-surface") && !!canvasRef.current?.contains(el);
  };
  const editable = () => focused() && !readOnly;
  const keyOpts = { when: editable };
  useKeybinding(["Delete"], () => commands.current.deleteSelection(), keyOpts);
  useKeybinding("Ctrl+C", () => void commands.current.copySelection(), { when: focused });
  useKeybinding("Ctrl+X", () => void (commands.current.copySelection() && commands.current.deleteSelection()), keyOpts);
  useKeybinding("Ctrl+V", () => commands.current.paste(), keyOpts);
  useKeybinding("Ctrl+D", () => commands.current.duplicate(), keyOpts);
  useKeybinding(
    "Ctrl+A",
    () => {
      const s = sessionRef.current;
      if (s) commands.current.select(s.doc.root.children.map((c) => c.uid));
    },
    { when: focused }
  );
  useKeybinding(
    "Escape",
    () => {
      const s = sessionRef.current;
      if (draggingRef.current || !s || s.selection.length === 0) return false;
      const parent = findParent(s.doc.root, s.selection[0]);
      commands.current.select(parent ? [parent.uid] : []);
    },
    { when: focused }
  );
  // Arrows move a widget 1px (Ctrl: 8px); with Shift they resize it.
  const ARROWS: Record<string, [number, number]> = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
  useKeybinding(
    ["Left", "Right", "Up", "Down"].flatMap((k) => [k, `Ctrl+${k}`, `Shift+${k}`, `Ctrl+Shift+${k}`]),
    (e) => {
      const [dx, dy] = ARROWS[e.key.toLowerCase()] ?? [0, 0];
      const by = e.ctrlKey || e.metaKey ? 8 : 1;
      commands.current.nudge(dx * by, dy * by, e.shiftKey);
    },
    keyOpts
  );

  return { focused, editable, keyOpts, ARROWS };
}

/** What `useDesignerKeys` gives. */
export type DesignerKeys = ReturnType<typeof useDesignerKeys>;
