// The open tabs, and opening a file into one (or revealing its tab).

import { type ComponentType, useCallback, useEffect, useRef, useState } from "react";
import { EDITOR_KIND, editorProviderById, fileNameOf, type FileOpenRequest, isBinaryFile, onOpenFileRequest, reportError, t, useGlobalStateStore, useLocale } from "substrate-platform-ui";
import { files } from "../../project/files";
import type { FileTab, OpenOptions } from "../openFilesContext";
import { newTabId, nextRevealSeq } from "./tabViews";

/** The open tabs, and opening a file into one (or revealing its tab). */
export function useOpenTabs() {
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
      const textLoaded = view ? editorProviderById(view)?.kind !== EDITOR_KIND.binary : !isBinaryFile(name);
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

  return { tabs, setTabs, tabsRef, componentCache, globalStore, pendingOpens, setViewRef, open };
}

/** What `useOpenTabs` gives the component. */
export type OpenTabs = ReturnType<typeof useOpenTabs>;
