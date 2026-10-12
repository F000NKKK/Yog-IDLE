import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  MenuBarItem,
  editorCanRedo,
  editorCanToggleComment,
  editorCanUndo,
  editorCopy,
  editorCut,
  editorChangeCase,
  editorCommentSelection,
  editorFind,
  editorReplace,
  editorGoToLine,
  editorSelectAll,
  editorUncommentSelection,
  editorHasSelection,
  editorPaste,
  editorRedo,
  editorSetText,
  editorToggleComment,
  editorUndo,
  useDocumentCommands,
  useEditorView,
  useKeybinding,
  formatShortcut,
  t,
  useT,
  type MenuBarDropdownEntry,
  type ToolbarSection,
} from "substrate-platform-ui";
import { useActiveFileTab, useOpenFiles } from "./OpenFilesContext";
import { extensionOf } from "./paths";
import { reportError } from "./reportError";
import { openCodeSearch, openFindInFiles } from "./search/searchUi";

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
  // A designer (no CodeMirror view) offers its own undo/clipboard commands.
  const doc = useDocumentCommands(view ? null : tab?.path);
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
      reportError(t("Format Document failed for {name}: {error}", { name: tab.name, error: String(err) }));
    }
  }

  return {
    tab,
    canSave: !!tab?.dirty,
    save: () => (tab ? save(tab.id) : Promise.resolve(true)),
    hasDirty,
    saveAll,
    close: () => (tab ? closeTab(tab.id) : Promise.resolve(true)),
    canUndo: view ? editorCanUndo(view) : !!doc?.canUndo(),
    undo: () => (view ? editorUndo(view) : doc?.undo()),
    canRedo: view ? editorCanRedo(view) : !!doc?.canRedo(),
    redo: () => (view ? editorRedo(view) : doc?.redo()),
    hasSelection: view ? editorHasSelection(view) : !!doc?.hasSelection(),
    canCut: view ? editorHasSelection(view) && !view.state.readOnly : !!doc?.hasSelection(),
    cut: () =>
      view ? editorCut(view).catch((err) => reportError(t("Cut failed: {error}", { error: String(err) }))) : doc?.cut(),
    copy: () =>
      view ? editorCopy(view).catch((err) => reportError(t("Copy failed: {error}", { error: String(err) }))) : doc?.copy(),
    canPaste: view ? !view.state.readOnly : !!doc?.canPaste(),
    paste: () =>
      view ? editorPaste(view).catch((err) => reportError(t("Paste failed: {error}", { error: String(err) }))) : doc?.paste(),
    canFind: !!view,
    find: () => view && editorFind(view),
    replace: () => view && editorReplace(view),
    goToLine: () => view && editorGoToLine(view),
    canSelectAll: !!view || !!doc,
    selectAll: () => (view ? editorSelectAll(view) : doc?.selectAll()),
    canEdit: !!view && !view.state.readOnly,
    lowercase: () => view && editorChangeCase(view, false),
    uppercase: () => view && editorChangeCase(view, true),
    commentSelection: () => view && editorCommentSelection(view),
    uncommentSelection: () => view && editorUncommentSelection(view),
    canToggleComment: !!view && editorCanToggleComment(view),
    toggleComment: () => view && editorToggleComment(view),
    canFormat,
    format,
  };
}

export type EditorActions = ReturnType<typeof useEditorActions>;

/** Keybindings that act on the active editor tab beyond CodeMirror's own (undo, find, toggle comment, ... are already bound inside each editor): Ctrl+S saves it, Ctrl+Shift+S saves every file, Ctrl+F4 / Ctrl+W closes it, Shift+Alt+F formats it. Renders nothing. */
export function EditorKeybindings({ actions }: { actions: EditorActions }) {
  useKeybinding("Ctrl+S", () => void actions.save(), { id: "file.save" });
  useKeybinding("Ctrl+Shift+S", () => void actions.saveAll(), { id: "file.saveAll" });
  useKeybinding(["Ctrl+F4", "Ctrl+W"], () => void actions.close(), { id: "file.close" });
  useKeybinding("Shift+Alt+F", () => void actions.format(), { id: "edit.format" });
  return null;
}

export function EditMenu({ actions: a }: { actions: EditorActions }) {
  const t = useT();
  const items: MenuBarDropdownEntry[] = [
    { label: t("Undo"), shortcut: "Ctrl+Z", disabled: !a.canUndo, onClick: a.undo },
    { label: t("Redo"), shortcut: "Ctrl+Y", disabled: !a.canRedo, onClick: a.redo },
    { label: t("Cut"), shortcut: "Ctrl+X", disabled: !a.canCut, onClick: a.cut, separatorBefore: true },
    { label: t("Copy"), shortcut: "Ctrl+C", disabled: !a.hasSelection, onClick: a.copy },
    { label: t("Paste"), shortcut: "Ctrl+V", disabled: !a.canPaste, onClick: a.paste },
    { label: t("Select All"), shortcut: "Ctrl+A", disabled: !a.canSelectAll, onClick: a.selectAll },
    {
      label: t("Find and Replace"),
      separatorBefore: true,
      items: [
        { label: t("Quick Find"), shortcut: "Ctrl+F", disabled: !a.canFind, onClick: a.find },
        { label: t("Quick Replace"), shortcut: "Ctrl+H", disabled: !a.canPaste, onClick: a.replace },
        { label: t("Find in Files"), shortcut: "Ctrl+Shift+F", onClick: () => openFindInFiles("find"), separatorBefore: true },
        { label: t("Replace in Files"), shortcut: "Ctrl+Shift+H", onClick: () => openFindInFiles("replace") },
      ],
    },
    {
      label: t("Go To"),
      items: [
        { label: t("Code Search…"), shortcut: "Ctrl+T", onClick: openCodeSearch },
        { label: t("Go To Line…"), shortcut: "Ctrl+G", disabled: !a.canFind, onClick: a.goToLine },
      ],
    },
    { label: t("Toggle Comment"), shortcut: "Ctrl+/", disabled: !a.canToggleComment, onClick: a.toggleComment, separatorBefore: true },
    { label: t("Comment Selection"), shortcut: "Ctrl+K Ctrl+C", disabled: !a.canToggleComment || !a.canEdit, onClick: a.commentSelection },
    { label: t("Uncomment Selection"), shortcut: "Ctrl+K Ctrl+U", disabled: !a.canToggleComment || !a.canEdit, onClick: a.uncommentSelection },
    { label: t("Make Lowercase"), shortcut: "Ctrl+U", disabled: !a.hasSelection || !a.canEdit, onClick: a.lowercase },
    { label: t("Make Uppercase"), shortcut: "Ctrl+Shift+U", disabled: !a.hasSelection || !a.canEdit, onClick: a.uppercase },
    { label: t("Format Document"), shortcut: "Shift+Alt+F", disabled: !a.canFormat, onClick: a.format },
  ];
  return <MenuBarItem label={t("Edit")} items={items} />;
}

/** The toolbar's editing sections — Save/Save All, Undo/Redo, Format/Toggle Comment — enabled by the active editor's state. */
export function editorToolbarSections(a: EditorActions): ToolbarSection[] {
  const withShortcut = (label: string, shortcut: string) => `${t(label)} (${formatShortcut(shortcut)})`;
  return [
    [
      { icon: "save", label: withShortcut("Save All", "Ctrl+Shift+S"), disabled: !a.hasDirty, onClick: a.saveAll },
    ],
    [
      { icon: "undo", label: withShortcut("Undo", "Ctrl+Z"), disabled: !a.canUndo, onClick: a.undo },
      { icon: "redo", label: withShortcut("Redo", "Ctrl+Y"), disabled: !a.canRedo, onClick: a.redo },
    ],
    [
      { icon: "format", label: withShortcut("Format Document", "Shift+Alt+F"), disabled: !a.canFormat, onClick: a.format },
      { icon: "comment", label: withShortcut("Toggle Comment", "Ctrl+/"), disabled: !a.canToggleComment, onClick: a.toggleComment },
    ],
  ];
}
