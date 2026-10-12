import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  MenuBarItem,
  editorCanRedo,
  editorCanToggleComment,
  editorCanUndo,
  editorCopy,
  editorCut,
  editorFind,
  editorHasSelection,
  editorPaste,
  editorRedo,
  editorSetText,
  editorToggleComment,
  editorUndo,
  useEditorView,
  useKeybinding,
  type MenuBarDropdownEntry,
  type ToolbarSection,
} from "substrate-platform-ui";
import { useActiveFileTab, useOpenFiles } from "./OpenFilesContext";
import { extensionOf } from "./paths";
import { reportError } from "./reportError";

// Whether Format Document works for a file kind (a formatter exists for it
// and is installed — `format_supported` on the Rust side), asked once per
// extension per session.
const formatSupport = new Map<string, Promise<boolean>>();

function formatSupported(path: string): Promise<boolean> {
  const ext = extensionOf(path);
  let known = formatSupport.get(ext);
  if (!known) {
    known = invoke<boolean>("format_supported", { path }).catch(() => false);
    formatSupport.set(ext, known);
  }
  return known;
}

function useFormatSupported(path: string | null): boolean {
  const [supported, setSupported] = useState<{ path: string; ok: boolean } | null>(null);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    formatSupported(path).then((ok) => !cancelled && setSupported({ path, ok }));
    return () => {
      cancelled = true;
    };
  }, [path]);
  return !!path && supported?.path === path && supported.ok;
}

/**
 * Everything the Edit menu, the editor toolbar and the editor keybindings
 * can do to the active file tab's editor — each `can*` tracks the live
 * editor state (re-rendered on every edit/selection change), so the UI
 * enables exactly what would do something. Must be used inside the shell.
 */
export function useEditorActions() {
  const tab = useActiveFileTab();
  const view = useEditorView(tab?.path);
  const { save, saveAll, hasDirty, closeTab } = useOpenFiles();
  const canFormat = useFormatSupported(view && tab ? tab.path : null) && !!view && !view.state.readOnly;

  async function format() {
    if (!view || !tab || !canFormat) return;
    const contents = view.state.doc.toString();
    try {
      const formatted = await invoke<string>("format_document", { path: tab.path, contents });
      // Skipped if the user typed while the formatter ran — its output
      // would silently undo that.
      if (view.state.doc.toString() === contents) editorSetText(view, formatted);
    } catch (err) {
      reportError(`Format Document failed for ${tab.name}: ${err}`);
    }
  }

  return {
    tab,
    canSave: !!tab?.dirty,
    save: () => (tab ? save(tab.id) : Promise.resolve(true)),
    hasDirty,
    saveAll,
    close: () => (tab ? closeTab(tab.id) : Promise.resolve(true)),
    canUndo: !!view && editorCanUndo(view),
    undo: () => view && editorUndo(view),
    canRedo: !!view && editorCanRedo(view),
    redo: () => view && editorRedo(view),
    hasSelection: !!view && editorHasSelection(view),
    cut: () => view && editorCut(view).catch((err) => reportError(`Cut failed: ${err}`)),
    copy: () => view && editorCopy(view).catch((err) => reportError(`Copy failed: ${err}`)),
    canPaste: !!view && !view.state.readOnly,
    paste: () => view && editorPaste(view).catch((err) => reportError(`Paste failed: ${err}`)),
    canFind: !!view,
    find: () => view && editorFind(view),
    canToggleComment: !!view && editorCanToggleComment(view),
    toggleComment: () => view && editorToggleComment(view),
    canFormat,
    format,
  };
}

export type EditorActions = ReturnType<typeof useEditorActions>;

/** Keybindings that act on the active editor tab beyond CodeMirror's own (undo, find, toggle comment, ... are already bound inside each editor): Ctrl+S saves it, Ctrl+Shift+S saves every file, Ctrl+F4 / Ctrl+W closes it, Shift+Alt+F formats it. Renders nothing. */
export function EditorKeybindings({ actions }: { actions: EditorActions }) {
  useKeybinding("Ctrl+S", () => actions.save(), { id: "file.save" });
  useKeybinding("Ctrl+Shift+S", () => actions.saveAll(), { id: "file.saveAll" });
  useKeybinding(["Ctrl+F4", "Ctrl+W"], () => actions.close(), { id: "file.close" });
  useKeybinding("Shift+Alt+F", () => actions.format(), { id: "edit.format" });
  return null;
}

export function EditMenu({ actions: a }: { actions: EditorActions }) {
  const items: MenuBarDropdownEntry[] = [
    { label: "Undo", shortcut: "Ctrl+Z", disabled: !a.canUndo, onClick: a.undo },
    { label: "Redo", shortcut: "Ctrl+Y", disabled: !a.canRedo, onClick: a.redo },
    { label: "Cut", shortcut: "Ctrl+X", disabled: !a.hasSelection || !a.canPaste, onClick: a.cut, separatorBefore: true },
    { label: "Copy", shortcut: "Ctrl+C", disabled: !a.hasSelection, onClick: a.copy },
    { label: "Paste", shortcut: "Ctrl+V", disabled: !a.canPaste, onClick: a.paste },
    { label: "Find", shortcut: "Ctrl+F", disabled: !a.canFind, onClick: a.find, separatorBefore: true },
    { label: "Toggle Comment", shortcut: "Ctrl+/", disabled: !a.canToggleComment, onClick: a.toggleComment, separatorBefore: true },
    { label: "Format Document", shortcut: "Shift+Alt+F", disabled: !a.canFormat, onClick: a.format },
  ];
  return <MenuBarItem label="Edit" items={items} />;
}

/** The toolbar's editing sections — Save/Save All, Undo/Redo, Format/Toggle Comment — enabled by the active editor's state. */
export function editorToolbarSections(a: EditorActions): ToolbarSection[] {
  return [
    [
      { icon: "save", label: "Save All (Ctrl+Shift+S)", disabled: !a.hasDirty, onClick: a.saveAll },
    ],
    [
      { icon: "undo", label: "Undo (Ctrl+Z)", disabled: !a.canUndo, onClick: a.undo },
      { icon: "redo", label: "Redo (Ctrl+Y)", disabled: !a.canRedo, onClick: a.redo },
    ],
    [
      { icon: "format", label: "Format Document (Shift+Alt+F)", disabled: !a.canFormat, onClick: a.format },
      { icon: "comment", label: "Toggle Comment (Ctrl+/)", disabled: !a.canToggleComment, onClick: a.toggleComment },
    ],
  ];
}
