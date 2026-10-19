// The keybindings and Edit menu commands.

import { useEffect, useRef } from "react";
import { type EditorProps, notifyDocumentCommands, registerDocumentCommands, useKeybinding } from "substrate-platform-ui";
import type { YresFile } from "./useYresFile";
import type { YresRowCommands } from "./useYresRowCommands";
import type { YresRows } from "./useYresRows";
import type { YresSiblings } from "./useYresSiblings";
import { YRES_SOURCE_VIEW } from "./yresModel";

/** The keybindings and Edit menu commands. */
export function useYresKeyboard(props: EditorProps, yresFile: YresFile, yresSiblings: YresSiblings, yresRows: YresRows, yresRowCommands: YresRowCommands) {
  const { path, readOnly } = props;
  const { setView, selected, setSelected, rootRef } = yresFile;
  const { tabsRef } = yresSiblings;
  const { rows } = yresRows;
  const { targetRows, deleteRows, copyRows, paste } = yresRowCommands;
  // ── Keyboard and Edit menu ──────────────────────────────────────────────

  const gridFocused = () => {
    const el = document.activeElement;
    return !!rootRef.current && !!el && rootRef.current.contains(el) && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement);
  };
  const editable = () => !readOnly && gridFocused();
  const focusedWithin = () => !!rootRef.current && rootRef.current.contains(document.activeElement);
  const commands = useRef({ deleteRows, copyRows, paste, targetRows, rows });
  commands.current = { deleteRows, copyRows, paste, targetRows, rows };

  useKeybinding("Delete", () => commands.current.deleteRows(), { when: editable });
  useKeybinding("Ctrl+C", () => void commands.current.copyRows(), { when: gridFocused });
  useKeybinding("Ctrl+X", () => void (commands.current.copyRows() && commands.current.deleteRows()), { when: editable });
  useKeybinding("Ctrl+V", () => void commands.current.paste(), { when: editable });
  const viewCode = () => {
    const tab = tabsRef.current.find((x) => x.path === path);
    if (tab) void setView(tab.id, YRES_SOURCE_VIEW);
  };
  useKeybinding("F7", viewCode, { when: focusedWithin });

  useEffect(
    () =>
      registerDocumentCommands(path, {
        hasSelection: () => commands.current.targetRows().length > 0,
        cut: () => void (commands.current.copyRows() && commands.current.deleteRows()),
        copy: () => void commands.current.copyRows(),
        canPaste: () => !readOnly,
        paste: () => void commands.current.paste(),
        selectAll: () => setSelected(new Set(commands.current.rows.map((r) => r.id))),
        delete: () => commands.current.deleteRows(),
      }),
    [path, readOnly]
  );
  useEffect(() => notifyDocumentCommands(), [selected]);

  return { gridFocused, editable, focusedWithin, commands, viewCode };
}

/** What `useYresKeyboard` gives the component. */
export type YresKeyboard = ReturnType<typeof useYresKeyboard>;
