import { createContext, useCallback, useContext, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { invalidateDesignResources } from "./lang/designResources";
import {
  type CodeEditorProps,
  type ContextMenuItem,
  type EditorProps,
  type EditorProvider,
  editorProviderById,
  editorProviderIcon,
  extensionOf,
  fileNameOf,
  type FileOpenRequest,
  forgetDocumentHistory,
  formatShortcut,
  getEditorView,
  InfoBar,
  isBinaryFile,
  MultiViewEditor,
  notify,
  onOpenFileRequest,
  openFile,
  type PanelAction,
  type PanelDef,
  reportError,
  revealLine,
  t,
  type TabMenuContext,
  useEditorProviders,
  useFilesChanged,
  useKeybinding,
  useLocale,
  useShell,
  useWatchedFolders,
} from "substrate-platform-ui";
import { useBreakpoints } from "./BreakpointsContext";
import { useDebugSessionContext } from "./DebugSessionContext";
import { addWatchItem, dataTipProvider } from "./debugger/DataTip";
import { useWatches } from "./debugger/WatchesContext";
import { samePath } from "./paths";
import { generatedSource, isGeneratedCode, isWithin, parentOf } from "./paths";
import { selectDocument } from "./ideSelection";
import { addCloseGuard } from "./windowClose";
import { useGlobalStateStore } from "./WorkspaceContext";
import { files } from "./files";
import { askToSave, isViewMap, newTabId, nextRevealSeq, openWithItems, regenerateScreen, tabViews, VIEWS_KEY } from "./openFiles/tabViews";

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

interface OpenOptions {
  /** Don't report a file that can't be read (restoring a remembered tab whose file is gone). */
  silent?: boolean;
  /** Bring the tab to the front (default `true`). */
  activate?: boolean;
}

interface OpenFilesContextValue {
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
  /** One `PanelDef` per open tab, fed straight into `PlatformShell`'s `extraCenterPanels` — no wrapper "Editor" panel around them. Each panel's `component` keeps a stable identity across renders (cached per tab id) so CodeMirror's internal state (undo history, cursor) survives every keystroke instead of remounting. */
  panels: PanelDef[];
}

export interface SideState {
  dirty: boolean;
  /** Writes the side state — throws (keeping the tab dirty, error reported) if that failed. */
  save: () => Promise<void>;
}

const OpenFilesContext = createContext<OpenFilesContextValue | null>(null);

/** Global state key: the view last chosen for each file extension — the next file of that kind opens in it. */
export function OpenFilesProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<FileTab[]>([]);
  // Tab titles, tab menus and view buttons are built here — rebuilt in a new locale.
  useLocale();
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const componentCache = useRef(new Map<string, ComponentType>());
  const globalStore = useGlobalStateStore();
  // Paths being read for opening right now — a second request for one
  // (a double-click) waits for the same read instead of opening it twice.
  const pendingOpens = useRef(new Map<string, Promise<string | null>>());
  // `open` is created before `setView` — reached through a ref.
  const setViewRef = useRef<(id: string, view: string) => Promise<void>>(async () => {});

  const open = useCallback(async (request: FileOpenRequest, options: OpenOptions = {}): Promise<string | null> => {
    const { path, line, column, view } = request;
    const activate = options.activate ?? true;
    const reveal = { seq: nextRevealSeq(), line, column, activate };
    const existing = tabsRef.current.find((t) => t.path === path);
    if (existing) {
      setTabs((prev) => prev.map((t) => (t.id === existing.id ? { ...t, reveal } : t)));
      if (view) await setViewRef.current(existing.id, view);
      return existing.id;
    }
    const inFlight = pendingOpens.current.get(path);
    if (inFlight) return inFlight;

    const name = request.name ?? fileNameOf(path);
    const opening = (async () => {
      let content: string;
      // A binary file's editor (e.g. `ImageEditor`, via the asset protocol)
      // reads the file itself and ignores `content` — reading it as UTF-8
      // text here would just fail, unless a text editor was asked for.
      const textLoaded = view ? editorProviderById(view)?.kind !== "binary" : !isBinaryFile(name);
      try {
        content = textLoaded ? await files.read(path) : "";
      } catch (err) {
        if (!options.silent) reportError(t("Failed to open {path}: {error}", { path, error: String(err) }));
        return null;
      }
      const id = newTabId();
      const tab: FileTab = { id, path, name, content, diskContent: content, dirty: false, sideDirty: false, contentVersion: 0, missing: false, textLoaded, pinned: false, view, reveal };
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
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, content, dirty: content !== t.diskContent || t.missing || t.sideDirty } : t)));
  }, []);

  const sideSaves = useRef(new Map<string, () => Promise<void>>());
  const setSideState = useCallback((path: string, state: SideState | null) => {
    if (state) sideSaves.current.set(path, state.save);
    else sideSaves.current.delete(path);
    const sideDirty = !!state?.dirty;
    setTabs((prev) =>
      prev.map((t) => (t.path === path && t.sideDirty !== sideDirty ? { ...t, sideDirty, dirty: t.content !== t.diskContent || t.missing || sideDirty } : t))
    );
  }, []);

  const save = useCallback(async (id: string): Promise<boolean> => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!tab || !tab.dirty) return true;
    // Its `content` is a placeholder "" (see `open`) — writing it would
    // wipe the file.
    if (!tab.textLoaded) return true;
    const side = sideSaves.current.get(tab.path);
    if (side && tab.sideDirty) {
      try {
        await side();
      } catch (err) {
        reportError(t("Failed to save {path}: {error}", { path: tab.path, error: String(err) }));
        return false;
      }
      if (tab.content === tab.diskContent && !tab.missing) return true;
    }
    const written = tab.content;
    try {
      await files.write(tab.path, written);
    } catch (err) {
      reportError(t("Failed to save {path}: {error}", { path: tab.path, error: String(err) }));
      return false;
    }
    // Still dirty if the user kept typing while the write was in flight.
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, diskContent: written, missing: false, dirty: t.content !== written || t.sideDirty } : t))
    );
    if (/\.(yui|yres|yblock|yitem)$/i.test(tab.path)) regenerateScreen(tab.path);
    if (/\.yres$/i.test(tab.path)) invalidateDesignResources();
    return true;
  }, []);

  const saveAs = useCallback(async (id: string, path: string): Promise<boolean> => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!tab || !tab.textLoaded) return false;
    const written = tab.content;
    try {
      await files.write(path, written);
    } catch (err) {
      reportError(t("Failed to save {path}: {error}", { path, error: String(err) }));
      return false;
    }
    setTabs((prev) =>
      prev.map((t) =>
        t.id === id ? { ...t, path, name: fileNameOf(path), diskContent: written, missing: false, dirty: t.content !== written || t.sideDirty } : t
      )
    );
    return true;
  }, []);

  const saveAll = useCallback(async (): Promise<boolean> => {
    let ok = true;
    for (const tab of tabsRef.current) if (tab.dirty && !(await save(tab.id))) ok = false;
    return ok;
  }, [save]);

  const removeTabs = useCallback((ids: string[]) => {
    for (const id of ids) {
      componentCache.current.delete(id);
      // Its Undo/Redo go with it.
      const path = tabsRef.current.find((t) => t.id === id)?.path;
      if (path) forgetDocumentHistory(path);
    }
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

  const setView = useCallback(async (id: string, view: string) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!tab) return;
    // A text editor picked for a file opened only as binary needs its text first.
    if (!tab.textLoaded && editorProviderById(view)?.kind !== "binary") {
      let content: string;
      try {
        content = await files.read(tab.path);
      } catch (err) {
        reportError(t("Can't open {path} as text: {error}", { path: tab.path, error: String(err) }));
        return;
      }
      setTabs((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, view, content, diskContent: content, textLoaded: true, dirty: t.sideDirty, contentVersion: t.contentVersion + 1 } : t
        )
      );
      return;
    }
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, view } : t)));
  }, []);
  setViewRef.current = setView;

  useEffect(() => addCloseGuard(confirmDiscardAll), [confirmDiscardAll]);

  const pathRenamed = useCallback((from: string, to: string) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (!isWithin(t.path, from)) return t;
        const path = to + t.path.slice(from.length);
        return { ...t, path, name: fileNameOf(path) };
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
      for (const tab of kept) {
        notify({ level: "warn", message: t("{name} was deleted, but has unsaved changes — they're kept open; save to recreate it.", { name: tab.name }) });
      }
    },
    [removeTabs]
  );

  const pathRemoved = useCallback((path: string) => markGone((t) => isWithin(t.path, path)), [markGone]);

  // Something else (a terminal, git, another editor) may have changed open
  // files while the window was in the background: on focus, reload tabs
  // without edits, and only *tell* about ones with edits — never overwrite
  // unsaved work. Files that vanished are handled like an Explorer delete.
  const warnedDisk = useRef(new Map<string, string>());
  const recheckDisk = useCallback(async (only?: Set<string>) => {
    const vanished = new Set<string>();
    for (const tab of tabsRef.current) {
      if (only && !only.has(tab.path)) continue;
      // A binary file (an image) isn't compared: changed on disk, its view
      // is told to show it anew.
      if (!tab.textLoaded) {
        if (only) setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, contentVersion: t.contentVersion + 1 } : t)));
        continue;
      }
      let disk: string;
      try {
        disk = await files.read(tab.path);
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
        // Changed on disk: steps from before don't apply to it.
        forgetDocumentHistory(tab.path);
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tab.id && !t.dirty ? { ...t, content: disk, diskContent: disk, missing: false, contentVersion: t.contentVersion + 1 } : t
          )
        );
      } else if (warnedDisk.current.get(tab.id) !== disk) {
        warnedDisk.current.set(tab.id, disk);
        notify({ level: "warn", message: t("{name} changed on disk — your unsaved changes are kept; saving will overwrite the file.", { name: current.name }) });
      }
    }
    if (vanished.size > 0) markGone((t) => vanished.has(t.id));
  }, [markGone]);
  useEffect(() => {
    const recheck = () => void recheckDisk();
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [recheckDisk]);
  // ...and while it's in front too: the open files' folders are watched (a
  // folder, not the file — editors that save by replacing the file would
  // leave a file watch behind).
  useWatchedFolders("open-files", tabs.map((t) => parentOf(t.path)));
  useFilesChanged((paths) => void recheckDisk(new Set(paths)));

  function getComponent(tabId: string): ComponentType {
    let component = componentCache.current.get(tabId);
    if (!component) {
      component = function FileEditorPanel() {
        const { tabs, updateContent } = useOpenFiles();
        const { forFile, toggle } = useBreakpoints();
        const { executionLocation, debugging } = useDebugSessionContext();
        const watches = useWatches();
        const { activateCenterPanel, showToolWindow } = useShell();
        const { activeCenterId } = useShell();
        const tab = tabs.find((t) => t.id === tabId);
        // Re-renders when editors are registered; the views themselves come from `tabViews`.
        useEditorProviders(tab?.path ?? "");
        const reveal = tab?.reveal;
        const ext = tab ? extensionOf(tab.name) : "";
        const { providers, active } = tab ? tabViews(tab, rememberedViews()) : { providers: [], active: undefined! };
        const textView = providers.find((p) => p.kind === "text");

        // VS Code's Markdown keys, for any file with more than one view:
        // Ctrl+Shift+V flips between the source and the preview/designer,
        // Ctrl+K V opens the preview to the side.
        const multiView = activeCenterId === tabId && !!tab && providers.length > 1;
        const side = providers.find((p) => editorProviderIcon(p) === "previewSide");
        const showView = (target: EditorProvider | undefined) => {
          if (!tab || !target) return false;
          chooseView(tab.id, target.id);
        };
        useKeybinding(
          "Ctrl+Shift+V",
          () => showView(active.kind === "text" && active === textView ? providers.find((p) => p.kind !== "text") : textView),
          { id: "editor.togglePreview", enabled: multiView },
        );
        useKeybinding("Ctrl+K V", () => showView(active === side ? textView : side), {
          id: "editor.previewToSide",
          enabled: multiView && !!side,
        });
        // A line to go to, waiting for a text view to be mounted — a reveal
        // into a tab showing a designer switches it to its text view first.
        const pendingLine = useRef<{ line: number; column?: number } | null>(null);

        useEffect(() => {
          if (!reveal || !tab) return;
          if (reveal.activate) activateCenterPanel(tab.id);
          if (reveal.line === undefined) return;
          pendingLine.current = { line: reveal.line, column: reveal.column };
          if (active.kind !== "text" && textView) setView(tab.id, textView.id);
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [reveal?.seq]);

        // Once the editor is laid out, move the cursor to the requested location.
        useEffect(() => {
          const target = pendingLine.current;
          if (!target || !tab || active.kind !== "text") return;
          const frame = requestAnimationFrame(() => {
            const editor = getEditorView(tab.path);
            if (!editor) return;
            pendingLine.current = null;
            revealLine(editor, target.line, target.column);
          });
          return () => cancelAnimationFrame(frame);
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [reveal?.seq, active.id]);

        if (!tab) return null;
        const onChange = (next: string) => updateContent(tab.id, next);
        // Only Rust source is actually debuggable (see the debugger backend —
        // it resolves breakpoints against a mod's own compiled native), so
        // only a `.rs` file's text view gets wired to `CodeEditorProps`'s
        // breakpoint gutter — every other editor's own props simply have no
        // such field.
        const renderView = (provider: EditorProvider, props: EditorProps) => {
          if (provider.kind === "text" && ext === "rs") {
            const CodeComponent = provider.component as ComponentType<CodeEditorProps>;
            return (
              <CodeComponent
                {...props}
                breakpoints={forFile(tab.path)}
                onToggleBreakpoint={(line) => toggle(tab.path, line)}
                executionLine={executionLocation && samePath(executionLocation.file, tab.path) ? executionLocation.line : null}
                // DataTips while paused, evaluated in the selected frame.
                hoverTip={executionLocation ? dataTipProvider(executionLocation.id) : undefined}
                contextMenu={(request) =>
                  debugging
                    ? [
                        addWatchItem(request, (expr) => {
                          watches.add(expr);
                          showToolWindow("debug");
                        }),
                      ]
                    : []
                }
              />
            );
          }
          return <provider.component {...props} />;
        };
        // Generated code (`.yog-build/generated/**.g.rs`) is shown read-only
        // under a notice naming its source, like Visual Studio's
        // auto-generated files.
        const generated = isGeneratedCode(tab.path);
        const editor = (
          <MultiViewEditor
            providers={providers}
            view={active.id}
            onViewChange={(id) => chooseView(tab.id, id)}
            // The views are buttons in the tab strip (`viewActions`), as in VS Code.
            showSwitcher={false}
            renderView={renderView}
            path={tab.path}
            content={tab.content}
            contentVersion={tab.contentVersion}
            onChange={onChange}
            readOnly={generated || undefined}
          />
        );
        return (
          // Focus anywhere in the editor shows it in Properties — its own
          // context (a designer's element) or its file; `display: contents`
          // keeps the wrapper out of the layout.
          <div style={{ display: "contents" }} onFocus={() => selectDocument(tab.path)}>
            {generated ? (
              <GeneratedFileBar path={tab.path} content={tab.content}>
                {editor}
              </GeneratedFileBar>            ) : (
              editor
            )}
          </div>
        );
      };
      componentCache.current.set(tabId, component);
    }
    return component;
  }

  function rememberedViews(): Record<string, string> {
    const stored = globalStore.get(VIEWS_KEY);
    return isViewMap(stored) ? (stored as Record<string, string>) : {};
  }

  /** Shows a tab in another view, remembered as the view for its kind of file. */
  function chooseView(tabId: string, view: string) {
    const tab = tabsRef.current.find((t) => t.id === tabId);
    if (!tab) return;
    void setView(tabId, view);
    globalStore.set(VIEWS_KEY, { ...rememberedViews(), [extensionOf(tab.name)]: view });
  }

  /** The tab-strip buttons for a file with several views — one per view, the shown one pressed. */
  function viewActions(tab: FileTab): PanelAction[] {
    const { providers, active } = tabViews(tab, rememberedViews());
    if (providers.length < 2) return [];
    const textView = providers.find((p) => p.kind === "text");
    return providers.map((p) => {
      const icon = editorProviderIcon(p);
      const keys = icon === "previewSide" ? "Ctrl+K V" : p === textView || p === providers.find((o) => o.kind !== "text") ? "Ctrl+Shift+V" : "";
      const shortcut = keys ? ` (${formatShortcut(keys)})` : "";
      return {
        id: p.id,
        icon,
        title: `${t(p.kind === "text" && icon !== "previewSide" ? "Show {view}" : "Open {view}", { view: t(p.label) })}${shortcut}`,
        active: p === active,
        onClick: () => chooseView(tab.id, p.id),
      };
    });
  }

  function tabMenu(tab: FileTab, { centerIds }: TabMenuContext): ContextMenuItem[] {
    const fileIds = new Set(tabsRef.current.map((t) => t.id));
    const unpinned = (ids: string[]) => ids.filter((id) => fileIds.has(id) && !tabsRef.current.find((t) => t.id === id)?.pinned);
    const toTheRight = unpinned(centerIds.slice(centerIds.indexOf(tab.id) + 1));
    const current = tabViews(tab, rememberedViews()).active.id;
    const copy = (text: string) => navigator.clipboard.writeText(text).catch((err) => reportError(t("Couldn't copy to the clipboard: {error}", { error: String(err) })));
    return [
      { label: t("Close"), onSelect: () => void closeTab(tab.id) },
      { label: t("Close All But This"), onSelect: () => void closeTabs(unpinned(centerIds).filter((id) => id !== tab.id)) },
      { label: t("Close All But Pinned"), onSelect: () => void closeTabs(unpinned(centerIds)) },
      { label: t("Close Tabs to the Right"), disabled: toTheRight.length === 0, onSelect: () => void closeTabs(toTheRight) },
      { label: t("Close All Tabs"), onSelect: () => void closeAll() },
      { label: tab.pinned ? t("Unpin Tab") : t("Pin Tab"), separatorBefore: true, onSelect: () => setPinned(tab.id, !tab.pinned) },
      { label: t("Copy Full Path"), separatorBefore: true, onSelect: () => void copy(tab.path) },
      { label: t("Copy File Name"), onSelect: () => void copy(tab.name) },
      {
        label: t("Open With"),
        separatorBefore: true,
        // A one-off for this tab, not remembered for its kind of file.
        submenu: openWithItems(tab.path, current, (view) => void setView(tab.id, view)),
      },
    ];
  }

  const panels: PanelDef[] = tabs.map((tab) => ({
    id: tab.id,
    title: `${tab.name}${tab.missing ? ` ${t("(deleted)")}` : ""}${tab.dirty ? " •" : ""}`,
    tooltip: tab.path,
    pinned: tab.pinned,
    onUnpin: () => setPinned(tab.id, false),
    contextMenu: (context) => tabMenu(tab, context),
    actions: viewActions(tab),
    component: getComponent(tab.id),
  }));
  const hasDirty = tabs.some((t) => t.dirty);

  return (
    <OpenFilesContext.Provider
      value={{
        tabs,
        open,
        updateContent,
        setSideState,
        closeTab,
        closeTabs,
        closeAll,
        setPinned,
        setView,
        save,
        saveAs,
        confirmUnsaved: confirmDiscardAll,
        discardAll: () => removeTabs(tabsRef.current.map((t) => t.id)),
        saveAll,
        hasDirty,
        pathRenamed,
        pathRemoved,
        recheckDisk,
        panels,
      }}
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

/** The read-only notice over a generated file: what it's generated from, with a link to open that source when it's one file. */
function GeneratedFileBar({ path, content, children }: { path: string; content: string; children: ReactNode }) {
  useLocale();
  const from = generatedSource(path, content);
  const message = from
    ? t("This file is generated by `yog build` from {source} and can't be edited here — changes would be lost on the next build.", { source: from.source })
    : t("This file is generated by `yog build` and can't be edited here — changes would be lost on the next build.");
  const file = from?.file;
  const actions = file ? [{ label: t("Open {file}", { file: fileNameOf(file) }), onClick: () => openFile({ path: file }) }] : undefined;
  return (
    <InfoBar message={message} actions={actions}>
      {children}
    </InfoBar>
  );
}
