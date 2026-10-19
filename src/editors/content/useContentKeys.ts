// The content editor's keys and Edit menu: Delete, Cut/Copy/Paste, Duplicate,
// the gizmo (G/S) and paint mode (P), the paint tools' keys, and F7.

import { useEffect, useRef } from "react";
import { type EditorProps, notifyDocumentCommands, registerDocumentCommands, useKeybinding } from "substrate-platform-ui";
import { MAX_BRUSH, type PaintState, toolKey } from "../../content/paint/PaintTools";
import type { GizmoMode } from "../../content/Viewport";
import type { ElementCommands } from "./elementCommands";
import type { ContentModel } from "./useContentModel";

/** Focus is in a text box or dropdown — its keys are its own. */
function inField(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

/** The editor's keybindings and Edit menu commands; returns `pickGizmo`, which the toolbar uses too. */
export function useContentKeys(props: EditorProps, m: ContentModel, el: ElementCommands, deleteSelected: () => void, viewCode: () => void) {
  const { path, readOnly } = props;
  const { rootRef, sel, elements, setGizmo, setPaintMode, paintMode, resolved, paint, setPaint } = m;
  const focusedWithin = () => !!rootRef.current && rootRef.current.contains(document.activeElement);
  const editable = () => !readOnly && focusedWithin() && !inField();
  const commands = useRef({ ...el, deleteSelected, sel, elements });
  commands.current = { ...el, deleteSelected, sel, elements };
  const cut = () => void commands.current.copyElement().then((ok) => ok && commands.current.deleteElement());
  useKeybinding("Delete", () => commands.current.deleteSelected(), { when: editable });
  useKeybinding("Ctrl+C", () => void commands.current.copyElement(), { when: editable });
  useKeybinding("Ctrl+X", cut, { when: editable });
  useKeybinding("Ctrl+V", () => void commands.current.pasteElement(), { when: editable });
  useKeybinding("Ctrl+D", () => commands.current.duplicateElement(), { when: editable });
  const pickGizmo = (g: GizmoMode) => {
    setGizmo(g);
    setPaintMode(false);
  };
  useKeybinding("G", () => pickGizmo("move"), { when: editable });
  useKeybinding("S", () => pickGizmo("resize"), { when: editable });
  useKeybinding("P", () => setPaintMode(true), { when: editable });
  usePaintKeys(() => editable() && (paintMode || !!resolved.sprite), paint, setPaint);
  useKeybinding("F7", viewCode, { when: focusedWithin });

  useEffect(
    () =>
      registerDocumentCommands(path, {
        hasSelection: () => commands.current.sel !== null,
        cut,
        copy: () => void commands.current.copyElement(),
        canPaste: () => !readOnly,
        paste: () => void commands.current.pasteElement(),
        selectAll: () => {},
        delete: () => commands.current.deleteElement(),
      }),
    [path, readOnly],
  );
  useEffect(() => notifyDocumentCommands(), [sel]);
  return { pickGizmo };
}

/** The paint tools' keys (`PAINT_TOOLS`), the mirror (M) and the brush size ([ ]) — while painting. */
function usePaintKeys(painting: () => boolean, paint: PaintState, setPaint: (patch: Partial<PaintState>) => void) {
  const paintRef = useRef(paint);
  paintRef.current = paint;
  const pick = (tool: PaintState["tool"]) => [toolKey(tool), () => setPaint({ tool }), { when: painting }] as const;
  useKeybinding(...pick("pencil"));
  useKeybinding(...pick("eraser"));
  useKeybinding(...pick("fill"));
  useKeybinding(...pick("picker"));
  useKeybinding(...pick("line"));
  useKeybinding(...pick("rect"));
  useKeybinding("M", () => setPaint({ mirrorX: !paintRef.current.mirrorX }), { when: painting });
  useKeybinding("[", () => setPaint({ size: Math.max(1, paintRef.current.size - 1) }), { when: painting });
  useKeybinding("]", () => setPaint({ size: Math.min(MAX_BRUSH, paintRef.current.size + 1) }), { when: painting });
}
