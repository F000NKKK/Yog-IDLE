import { createContext, useCallback, useContext, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  editorProvidersFor,
  getEditorView,
  isBinaryFile,
  MultiViewEditor,
  notify,
  revealLine,
  showDialog,
  useEditorProviders,
  useShell,
  type CodeEditorProps,
  type ContextMenuItem,
  type EditorProps,
  type EditorProvider,
  type PanelDef,
  type TabMenuContext,
} from "substrate-platform-ui";
import { useBreakpoints } from "./BreakpointsContext";
import { useDebugSessionContext } from "./DebugSessionContext";
import { samePath } from "./paths";
import { onOpenFileRequest, type FileOpenRequest } from "./fileOpenBus";
import { baseName, isWithin } from "./paths";
import { reportError } from "./reportError";
import { addCloseGuard } from "./windowClose";
import { useGlobalState } from "./WorkspaceContext";

interface FileTab {
  /** Stable for the tab's lifetime (survives a rename) — the dock panel id. */
  id: string;
  path: string;
  name: string;
  /** The editor's current text. */
  content: string;
  /** What's on disk, as last read or written — `content` differing from it is what `dirty` means. */
  diskContent: string;
  dirty: boolean;
  /** Bumped when `content` was replaced from outside the editor (reloaded from disk) — see `EditorProps.contentVersion`. */
  contentVersion: number;
  /** The file was deleted (or renamed away) on disk while this tab had unsaved edits — kept open so they aren't lost; saving recreates it. */
  missing: boolean;
  /** Kept at the front of the tab strip, and out of "Close All But This" and the like. */
  pinned: boolean;
  /** The editor provider this tab shows ("Open With…" / the view switcher) — unset means the default for its kind of file. */
  view?: string;
  /** The latest request to show this tab — a new `seq` activates it and, with `line`, moves the cursor there. */
  reveal?: { seq: number; line?: number; column?: number; activate: boolean };
}

interface OpenOptions {
  /** Don't report a file that can't be read (restoring a remembered tab whose file is gone). */
  silent?: boolean;
  /** Bring the tab to the front (default `true`). */
  activate?: boolean;
}

interface OpenFilesContextValue {
  tabs: FileTab[];
  /** Opens (or re-reveals) a file — resolves with its tab id, or `null` if it couldn't be read. `openFile` from `fileOpenBus` is the same thing for callers outside this context. */
  open: (request: FileOpenRequest, options?: OpenOptions) => Promise<string | null>;
  updateContent: (id: string, content: string) => void;
  /** Closes a tab, first asking Save / Don't Save / Cancel if it has unsaved edits — resolves `false` if it stayed open. */
  closeTab: (id: string) => Promise<boolean>;
  /** Closes these tabs, asking once about all unsaved ones among them — resolves `false` if cancelled (nothing closed). */
  closeTabs: (ids: string[]) => Promise<boolean>;
  /** Closes every tab, asking once about all unsaved ones — resolves `false` if cancelled (nothing closed). */
  closeAll: () => Promise<boolean>;
  setPinned: (id: string, pinned: boolean) => void;
  /** Shows a tab through another editor provider (by id). */
  setView: (id: string, view: string) => void;
  /** Writes a tab to disk — resolves `false` (tab stays dirty, error reported) if that failed. */
  save: (id: string) => Promise<boolean>;
  saveAll: () => Promise<boolean>;
  hasDirty: boolean;
  /** Explorer renamed `from` (a file, or a folder containing open files) to `to` — open tabs follow it. */
  pathRenamed: (from: string, to: string) => void;
  /** Explorer deleted `path` (a file or folder) — clean tabs under it close, dirty ones are kept, marked deleted. */
  pathRemoved: (path: string) => void;
  /** One `PanelDef` per open tab, fed straight into `PlatformShell`'s `extraCenterPanels` — no wrapper "Editor" panel around them. Each panel's `component` keeps a stable identity across renders (cached per tab id) so CodeMirror's internal state (undo history, cursor) survives every keystroke instead of remounting. */
  panels: PanelDef[];
}

const OpenFilesContext = createContext<OpenFilesContextValue | null>(null);

let nextTabId = 0;
let nextRevealSeq = 0;

/** Save / Don't Save / Cancel about `names` — resolves `"save"`, `"discard"` or `"cancel"`. */
async function askToSave(names: string[]): Promise<string> {
  const many = names.length > 1;
  const result = await showDialog({
    title: "Unsaved Changes",
    message: many ? (
      <>
        Save changes to the following files?
        <ul>
          {names.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </>
    ) : (
      `Save changes to ${names[0]}?`
    ),
    buttons: [
      { id: "cancel", label: "Cancel", cancel: true },
      { id: "discard", label: "Don't Save" },
      { id: "save", label: many ? "Save All" : "Save", variant: "primary" },
    ],
  });
  return result.button;
}

/**
 * Owns every open file tab — subscribes to `fileOpenBus` (since Project
 * Explorer, the debugger and others request opens from unrelated parts of
 * the component tree), and hands out one real dock `PanelDef` per tab so
 * the shell's own center-dock tab strip *is* the file tab strip, with no
 * extra nesting.
 *
 * Unsaved work is never dropped silently: closing a dirty tab (or the
 * window) asks first, a failed save keeps the tab dirty, and a file changed
 * on disk only reloads into a tab without edits (checked whenever the
 * window regains focus).
 */
export function OpenFilesProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const componentCache = useRef(new Map<string, ComponentType>());
  // Paths being read for opening right now — a second request for one
  // (a double-click) waits for the same read instead of opening it twice.
  const pendingOpens = useRef(new Map<string, Promise<string | null>>());

  const open = useCallback(async (request: FileOpenRequest, options: OpenOptions = {}): Promise<string | null> => {
    const { path, line, column } = request;
    const activate = options.activate ?? true;
    const reveal = { seq: ++nextRevealSeq, line, column, activate };
    const existing = tabsRef.current.find((t) => t.path === path);
    if (existing) {
      setTabs((prev) => prev.map((t) => (t.id === existing.id ? { ...t, reveal } : t)));
      return existing.id;
    }
    const inFlight = pendingOpens.current.get(path);
    if (inFlight) return inFlight;

    const name = request.name ?? baseName(path);
    const opening = (async () => {
      let content: string;
      try {
        // A binary file's editor (e.g. `ImageEditor`, via the asset
        // protocol) reads the file itself and ignores `content` — reading
        // it as UTF-8 text here would just fail.
        content = isBinaryFile(name) ? "" : await invoke<string>("file_read", { path });
      } catch (err) {
        if (!options.silent) reportError(`Failed to open ${path}: ${err}`);
        return null;
      }
      const id = `file-${++nextTabId}`;
      const tab: FileTab = { id, path, name, content, diskContent: content, dirty: false, contentVersion: 0, missing: false, pinned: false, reveal };
      // Into the ref right away, not on the next render: once this promise
      // settles `pendingOpens` forgets the path, and an `open` of the same
      // path before React re-renders (restoring the active tab does exactly
      // that) would otherwise find neither and open a duplicate.
      tabsRef.current = [...tabsRef.current, tab];
      setTabs((prev) => [...prev, tab]);
      return id;
    })();
    pendingOpens.current.set(path, opening);
    try {
      return await opening;
    } finally {
      pendingOpens.current.delete(path);
    }
  }, []);

  useEffect(() => onOpenFileRequest((request) => void open(request)), [open]);

  const updateContent = useCallback((id: string, content: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, content, dirty: content !== t.diskContent || t.missing } : t)));
  }, []);

  const save = useCallback(async (id: string): Promise<boolean> => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!tab || !tab.dirty) return true;
    // Its `content` is a placeholder "" (see `open`) — writing it would
    // wipe the file.
    if (isBinaryFile(tab.name)) return true;
    const written = tab.content;
    try {
      await invoke("file_write", { path: tab.path, contents: written });
    } catch (err) {
      reportError(`Failed to save ${tab.path}: ${err}`);
      return false;
    }
    // Still dirty if the user kept typing while the write was in flight.
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, diskContent: written, missing: false, dirty: t.content !== written } : t))
    );
    return true;
  }, []);

  const saveAll = useCallback(async (): Promise<boolean> => {
    let ok = true;
    for (const tab of tabsRef.current) if (tab.dirty && !(await save(tab.id))) ok = false;
    return ok;
  }, [save]);

  const removeTabs = useCallback((ids: string[]) => {
    for (const id of ids) componentCache.current.delete(id);
    setTabs((prev) => prev.filter((t) => !ids.includes(t.id)));
  }, []);

  const closeTab = useCallback(
    async (id: string): Promise<boolean> => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab) return true;
      if (tab.dirty) {
        const choice = await askToSave([tab.name]);
        if (choice === "cancel") return false;
        if (choice === "save" && !(await save(id))) return false;
      }
      removeTabs([id]);
      return true;
    },
    [save, removeTabs]
  );

  /** Asks about the dirty ones among `ids` at once — resolves `false` if the user cancelled or a save failed. */
  const confirmDiscard = useCallback(
    async (ids: string[]): Promise<boolean> => {
      const dirty = tabsRef.current.filter((t) => t.dirty && ids.includes(t.id));
      if (dirty.length === 0) return true;
      const choice = await askToSave(dirty.map((t) => t.name));
      if (choice === "cancel") return false;
      if (choice === "save") {
        let ok = true;
        for (const tab of dirty) if (!(await save(tab.id))) ok = false;
        return ok;
      }
      return true;
    },
    [save]
  );

  const confirmDiscardAll = useCallback(() => confirmDiscard(tabsRef.current.map((t) => t.id)), [confirmDiscard]);

  const closeTabs = useCallback(
    async (ids: string[]): Promise<boolean> => {
      if (!(await confirmDiscard(ids))) return false;
      removeTabs(ids);
      return true;
    },
    [confirmDiscard, removeTabs]
  );

  const closeAll = useCallback(() => closeTabs(tabsRef.current.map((t) => t.id)), [closeTabs]);

  const setPinned = useCallback((id: string, pinned: boolean) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, pinned } : t)));
  }, []);

  const setView = useCallback((id: string, view: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, view } : t)));
  }, []);

  useEffect(() => addCloseGuard(confirmDiscardAll), [confirmDiscardAll]);

  const pathRenamed = useCallback((from: string, to: string) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (!isWithin(t.path, from)) return t;
        const path = to + t.path.slice(from.length);
        return { ...t, path, name: baseName(path) };
      })
    );
  }, []);

  const markGone = useCallback(
    (paths: (t: FileTab) => boolean) => {
      const gone = tabsRef.current.filter(paths);
      removeTabs(gone.filter((t) => !t.dirty).map((t) => t.id));
      const kept = gone.filter((t) => t.dirty && !t.missing);
      if (kept.length === 0) return;
      setTabs((prev) => prev.map((t) => (kept.some((k) => k.id === t.id) ? { ...t, missing: true } : t)));
      for (const t of kept) notify({ level: "warn", message: `${t.name} was deleted, but has unsaved changes — they're kept open; save to recreate it.` });
    },
    [removeTabs]
  );

  const pathRemoved = useCallback((path: string) => markGone((t) => isWithin(t.path, path)), [markGone]);

  // Something else (a terminal, git, another editor) may have changed open
  // files while the window was in the background: on focus, reload tabs
  // without edits, and only *tell* about ones with edits — never overwrite
  // unsaved work. Files that vanished are handled like an Explorer delete.
  const warnedDisk = useRef(new Map<string, string>());
  useEffect(() => {
    async function recheck() {
      const vanished = new Set<string>();
      for (const tab of tabsRef.current) {
        if (isBinaryFile(tab.name)) continue;
        let disk: string;
        try {
          disk = await invoke<string>("file_read", { path: tab.path });
        } catch {
          vanished.add(tab.id);
          continue;
        }
        const current = tabsRef.current.find((t) => t.id === tab.id);
        if (!current) continue;
        if (disk === current.diskContent) {
          // Back again (restored by git, say) — no longer "deleted".
          if (current.missing) setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, missing: false } : t)));
          continue;
        }
        if (!current.dirty) {
          setTabs((prev) =>
            prev.map((t) =>
              t.id === tab.id && !t.dirty ? { ...t, content: disk, diskContent: disk, missing: false, contentVersion: t.contentVersion + 1 } : t
            )
          );
        } else if (warnedDisk.current.get(tab.id) !== disk) {
          warnedDisk.current.set(tab.id, disk);
          notify({ level: "warn", message: `${current.name} changed on disk — your unsaved changes are kept; saving will overwrite the file.` });
        }
      }
      if (vanished.size > 0) markGone((t) => vanished.has(t.id));
    }
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [markGone]);

  function getComponent(tabId: string): ComponentType {
    let component = componentCache.current.get(tabId);
    if (!component) {
      component = function FileEditorPanel() {
        const { tabs, updateContent } = useOpenFiles();
        const { forFile, toggle } = useBreakpoints();
        const { executionLocation } = useDebugSessionContext();
        const { activateCenterPanel } = useShell();
        const tab = tabs.find((t) => t.id === tabId);
        const reveal = tab?.reveal;

        // A reveal request: bring this tab to the front, then (once the
        // editor is laid out) move the cursor to the requested location.
        useEffect(() => {
          if (!reveal || !tab) return;
          if (reveal.activate) activateCenterPanel(tab.id);
          if (reveal.line === undefined) return;
          const line = reveal.line;
          const frame = requestAnimationFrame(() => {
            const view = getEditorView(tab.path);
            if (view) revealLine(view, line, reveal.column);
          });
          return () => cancelAnimationFrame(frame);
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [reveal?.seq]);

        if (!tab) return null;
        const EditorComponent = resolveEditor(tab.name);
        const onChange = (next: string) => updateContent(tab.id, next);
        // Only Rust source is actually debuggable (see the debugger backend —
        // it resolves breakpoints against a mod's own compiled native), so
        // only `.rs` files get wired to `CodeEditorProps`'s breakpoint gutter
        // — every other file kind's own props simply have no such field.
        if (tab.name.toLowerCase().endsWith(".rs")) {
          const CodeComponent = EditorComponent as ComponentType<CodeEditorProps>;
          return (
            <CodeComponent
              path={tab.path}
              content={tab.content}
              contentVersion={tab.contentVersion}
              onChange={onChange}
              breakpoints={forFile(tab.path)}
              onToggleBreakpoint={(line) => toggle(tab.path, line)}
              executionLine={executionLocation && samePath(executionLocation.file, tab.path) ? executionLocation.line : null}
            />
          );
        }
        return <EditorComponent path={tab.path} content={tab.content} contentVersion={tab.contentVersion} onChange={onChange} />;
      };
      componentCache.current.set(tabId, component);
    }
    return component;
  }

  const panels: PanelDef[] = tabs.map((t) => ({
    id: t.id,
    title: `${t.name}${t.missing ? " (deleted)" : ""}${t.dirty ? " •" : ""}`,
    component: getComponent(t.id),
  }));
  const hasDirty = tabs.some((t) => t.dirty);

  return (
    <OpenFilesContext.Provider
      value={{ tabs, open, updateContent, closeTab, closeAll, save, saveAll, hasDirty, pathRenamed, pathRemoved, panels }}
    >
      {children}
    </OpenFilesContext.Provider>
  );
}

export function useOpenFiles(): OpenFilesContextValue {
  const ctx = useContext(OpenFilesContext);
  if (!ctx) throw new Error("useOpenFiles must be used within an OpenFilesProvider");
  return ctx;
}

/** The open file tab that's the active center-dock tab, if any — for the editor toolbar and Edit menu. Must be used inside the shell. */
export function useActiveFileTab(): FileTab | null {
  const { tabs } = useOpenFiles();
  const { activeCenterId } = useShell();
  return tabs.find((t) => t.id === activeCenterId) ?? null;
}
