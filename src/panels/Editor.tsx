import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Tab, resolveEditor } from "substrate-platform-ui";
import { onOpenFileRequest } from "../fileOpenBus";
import "./Editor.css";

interface FileTab {
  id: string;
  path: string;
  name: string;
  content: string;
  dirty: boolean;
}

/**
 * A VS-Code-style multi-document editor, replacing the old Designer stub —
 * every file opened from Solution Explorer becomes its own tab here (via
 * `fileOpenBus`, since sibling dock panels have no direct prop channel
 * between them). Inactive tabs stay mounted so their editor's internal
 * state (undo history, cursor position) survives switching away, same
 * pattern `TerminalPanel` uses for its sessions.
 */
export function Editor() {
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(
    () =>
      onOpenFileRequest(({ path, name }) => {
        const existing = tabsRef.current.find((t) => t.path === path);
        if (existing) {
          setActiveId(existing.id);
          return;
        }
        invoke<string>("file_read", { path })
          .then((content) => {
            setTabs((prev) => [...prev, { id: path, path, name, content, dirty: false }]);
            setActiveId(path);
          })
          .catch((err) => console.error(`failed to open ${path}:`, err));
      }),
    []
  );

  function updateContent(id: string, content: string) {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, content, dirty: true } : t)));
  }

  function closeTab(id: string) {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      setActiveId((cur) => (cur !== id ? cur : (next[idx]?.id ?? next[idx - 1]?.id ?? next[0]?.id ?? null)));
      return next;
    });
  }

  async function save(id: string) {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!tab || !tab.dirty) return;
    await invoke("file_write", { path: tab.path, contents: tab.content }).catch((err) => console.error(`failed to save ${tab.path}:`, err));
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, dirty: false } : t)));
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (activeId) save(activeId);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  if (tabs.length === 0) {
    return (
      <div className="sp-editor-empty">
        <p>Open a file from Solution Explorer to start editing.</p>
      </div>
    );
  }

  return (
    <div className="sp-editor">
      <div className="sp-editor-tabs">
        {tabs.map((t) => (
          <Tab key={t.id} orientation="horizontal" active={t.id === activeId} onClick={() => setActiveId(t.id)} onRequestClose={() => closeTab(t.id)}>
            {t.dirty ? `${t.name} •` : t.name}
          </Tab>
        ))}
      </div>
      <div className="sp-editor-views">
        {tabs.map((t) => {
          const EditorComponent = resolveEditor(t.name);
          return (
            <div key={t.id} className="sp-editor-view" data-active={t.id === activeId || undefined}>
              <EditorComponent path={t.path} content={t.content} onChange={(next) => updateContent(t.id, next)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
