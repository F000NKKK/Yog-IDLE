// The open files' context: the tabs, and what can be done with them.

import { createContext, useContext } from "react";
import { type FileOpenRequest, type PanelDef, useShell } from "substrate-platform-ui";

export interface FileTab {
  /** Stable for the tab's lifetime (survives a rename) — the dock panel id. */
  id: string;
  path: string;
  name: string;
  /** The editor's current text. */
  content: string;
  /** What's on disk, as last read or written — `content` differing from it is what `dirty` means. */
  diskContent: string;
  dirty: boolean;
  /** The editor has unsaved state besides the text (painted textures, say) — see `setSideState`. */
  sideDirty: boolean;
  /** Bumped when `content` was replaced from outside the editor (reloaded from disk) — see `EditorProps.contentVersion`. */
  contentVersion: number;
  /** The file was deleted (or renamed away) on disk while this tab had unsaved edits — kept open so they aren't lost; saving recreates it. */
  missing: boolean;
  /** `content` holds the file's text — false for a file opened only in a binary editor (an image preview), until a text editor is chosen for it. */
  textLoaded: boolean;
  /** Kept at the front of the tab strip, and out of "Close All But This" and the like. */
  pinned: boolean;
  /** The editor provider this tab shows ("Open With…" / the view switcher) — unset means the default for its kind of file. */
  view?: string;
  /** The latest request to show this tab — a new `seq` activates it and, with `line`, moves the cursor there. */
  reveal?: { seq: number; line?: number; column?: number; activate: boolean };
}

export interface OpenOptions {
  /** Don't report a file that can't be read (restoring a remembered tab whose file is gone). */
  silent?: boolean;
  /** Bring the tab to the front (default `true`). */
  activate?: boolean;
}

export interface OpenFilesContextValue {
  tabs: FileTab[];
  /** Opens (or re-reveals) a file — resolves with its tab id, or `null` if it couldn't be read. Substrate's `openFile` is the same thing for callers outside this context. */
  open: (request: FileOpenRequest, options?: OpenOptions) => Promise<string | null>;
  updateContent: (id: string, content: string) => void;
  /**
   * An editor's unsaved state besides its file's text (the textures a model
   * editor paints, say): `dirty` marks the tab dirty like unsaved text does,
   * and Save runs `save` before writing the text. `null` when the editor goes.
   */
  setSideState: (path: string, state: SideState | null) => void;
  /** Closes a tab, first asking Save / Don't Save / Cancel if it has unsaved edits — resolves `false` if it stayed open. */
  closeTab: (id: string) => Promise<boolean>;
  /** Closes these tabs, asking once about all unsaved ones among them — resolves `false` if cancelled (nothing closed). */
  closeTabs: (ids: string[]) => Promise<boolean>;
  /** Closes every tab, asking once about all unsaved ones — resolves `false` if cancelled (nothing closed). */
  closeAll: () => Promise<boolean>;
  setPinned: (id: string, pinned: boolean) => void;
  /** Shows a tab through another editor provider (by id). */
  setView: (id: string, view: string) => Promise<void>;
  /** Writes a tab to disk — resolves `false` (tab stays dirty, error reported) if that failed. */
  save: (id: string) => Promise<boolean>;
  /** Writes a tab's text to `path` and makes the tab that file (the original stays as it was on disk) — resolves `false` if the write failed. */
  saveAs: (id: string, path: string) => Promise<boolean>;
  /** Save / Don't Save / Cancel about every unsaved tab at once — resolves `false` if cancelled or a save failed. Nothing is closed. */
  confirmUnsaved: () => Promise<boolean>;
  /** Closes every tab without asking — after `confirmUnsaved`. */
  discardAll: () => void;
  saveAll: () => Promise<boolean>;
  hasDirty: boolean;
  /** Explorer renamed `from` (a file, or a folder containing open files) to `to` — open tabs follow it. */
  pathRenamed: (from: string, to: string) => void;
  /** Explorer deleted `path` (a file or folder) — clean tabs under it close, dirty ones are kept, marked deleted. */
  pathRemoved: (path: string) => void;
  /** Re-reads open files from disk now (as on window focus) — after something in the IDE itself rewrote one, e.g. Properties editing `yog.toml`. */
  recheckDisk: () => Promise<void>;
  /** Shows a tab in another view, remembered as the view for its kind of file. */
  chooseView: (tabId: string, view: string) => void;
  /** The view last chosen for each file extension. */
  rememberedViews: () => Record<string, string>;
  /** One `PanelDef` per open tab, fed straight into `PlatformShell`'s `extraCenterPanels` — no wrapper "Editor" panel around them. Each panel's `component` keeps a stable identity across renders (cached per tab id) so CodeMirror's internal state (undo history, cursor) survives every keystroke instead of remounting. */
  panels: PanelDef[];
}

export interface SideState {
  dirty: boolean;
  /** Writes the side state — throws (keeping the tab dirty, error reported) if that failed. */
  save: () => Promise<void>;
}

export const OpenFilesContext = createContext<OpenFilesContextValue | null>(null);

export function useOpenFiles(): OpenFilesContextValue {
  const ctx = useContext(OpenFilesContext);
  if (!ctx) throw new Error("useOpenFiles must be used within an OpenFilesProvider");
  return ctx;
}

/** The open files, or `null` outside the shell (an editor alone in a harness page). */
export function useOpenFilesIfAny(): OpenFilesContextValue | null {
  return useContext(OpenFilesContext);
}

/** The open file tab that's the active center-dock tab, if any — for the editor toolbar and Edit menu. Must be used inside the shell. */
export function useActiveFileTab(): FileTab | null {
  const { tabs } = useOpenFiles();
  const { activeCenterId } = useShell();
  return tabs.find((t) => t.id === activeCenterId) ?? null;
}
