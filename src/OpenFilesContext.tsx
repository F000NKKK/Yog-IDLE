import { createContext, useCallback, useContext, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { resolveEditor, type PanelDef } from "substrate-platform-ui";
import { onOpenFileRequest } from "./fileOpenBus";

interface FileTab {
  id: string;
  path: string;
  name: string;
  content: string;
  dirty: boolean;
}

interface OpenFilesContextValue {
  tabs: FileTab[];
  updateContent: (id: string, content: string) => void;
  closeTab: (id: string) => void;
  save: (id: string) => Promise<void>;
  saveAll: () => void;
  hasDirty: boolean;
  /** One `PanelDef` per open tab, fed straight into `PlatformShell`'s `extraCenterPanels` — no wrapper "Editor" panel around them. Each panel's `component` keeps a stable identity across renders (cached per tab id) so CodeMirror's internal state (undo history, cursor) survives every keystroke instead of remounting. */
  panels: PanelDef[];
}

const OpenFilesContext = createContext<OpenFilesContextValue | null>(null);

/**
 * Owns every open file tab — subscribes to `fileOpenBus` (since Solution
 * Explorer, which requests opens, and this provider live in unrelated parts
 * of the component tree), and hands out one real dock `PanelDef` per tab so
 * the shell's own center-dock tab strip *is* the file tab strip, with no
 * extra nesting.
 */
export function OpenFilesProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const componentCache = useRef(new Map<string, ComponentType>());

  useEffect(
    () =>
      onOpenFileRequest(({ path, name }) => {
        if (tabsRef.current.some((t) => t.path === path)) return;
        invoke<string>("file_read", { path })
          .then((content) => setTabs((prev) => [...prev, { id: path, path, name, content, dirty: false }]))
          .catch((err) => console.error(`failed to open ${path}:`, err));
      }),
    []
  );

  const updateContent = useCallback((id: string, content: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, content, dirty: true } : t)));
  }, []);

  const closeTab = useCallback((id: string) => {
    componentCache.current.delete(id);
    setTabs((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const save = useCallback(async (id: string) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!tab || !tab.dirty) return;
    await invoke("file_write", { path: tab.path, contents: tab.content }).catch((err) => console.error(`failed to save ${tab.path}:`, err));
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, dirty: false } : t)));
  }, []);

  // Saves every dirty tab rather than just "the active one" — the shell
  // (not this provider) owns which center tab is currently active, so this
  // avoids needing that wired out just for a keybinding/toolbar button, and
  // it can never lose unsaved work in a tab the user forgot was dirty.
  const saveAll = useCallback(() => {
    for (const tab of tabsRef.current) if (tab.dirty) save(tab.id);
  }, [save]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveAll();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveAll]);

  function getComponent(tabId: string): ComponentType {
    let component = componentCache.current.get(tabId);
    if (!component) {
      component = function FileEditorPanel() {
        const { tabs, updateContent } = useOpenFiles();
        const tab = tabs.find((t) => t.id === tabId);
        if (!tab) return null;
        const EditorComponent = resolveEditor(tab.name);
        return <EditorComponent path={tab.path} content={tab.content} onChange={(next) => updateContent(tab.id, next)} />;
      };
      componentCache.current.set(tabId, component);
    }
    return component;
  }

  const panels: PanelDef[] = tabs.map((t) => ({ id: t.id, title: t.dirty ? `${t.name} •` : t.name, component: getComponent(t.id) }));
  const hasDirty = tabs.some((t) => t.dirty);

  return (
    <OpenFilesContext.Provider value={{ tabs, updateContent, closeTab, save, saveAll, hasDirty, panels }}>
      {children}
    </OpenFilesContext.Provider>
  );
}

export function useOpenFiles(): OpenFilesContextValue {
  const ctx = useContext(OpenFilesContext);
  if (!ctx) throw new Error("useOpenFiles must be used within an OpenFilesProvider");
  return ctx;
}
