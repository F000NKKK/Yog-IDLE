import { useEffect, useRef } from "react";
import { getEditorView, useShell, useStateStore } from "substrate-platform-ui";
import { useOpenFiles } from "./OpenFilesContext";
import { addWorkspaceCollector } from "./WorkspaceContext";

/** What `"openFiles"` holds in the workspace state: the tabs in order, each with its cursor, and which one was in front. */
interface PersistedOpenFiles {
  files: { path: string; line?: number; column?: number }[];
  active?: string;
}

const OPEN_FILES_KEY = "openFiles";

function isPersistedOpenFiles(value: unknown): value is PersistedOpenFiles {
  const v = value as PersistedOpenFiles;
  return !!v && Array.isArray(v.files) && v.files.every((f) => f && typeof f.path === "string");
}

/**
 * Remembers the open file tabs per project — reopens them (in order, cursor
 * where it was, the same tab in front) when the project is opened again,
 * silently skipping any file that no longer exists. Tabs open when another
 * project is opened close if clean (unsaved ones stay, so nothing is lost).
 * Renders nothing; must be inside the shell.
 */
export function OpenFilesPersistence() {
  const { tabs, open, closeTab } = useOpenFiles();
  const { activeCenterId } = useShell();
  const store = useStateStore();
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(activeCenterId);
  activeRef.current = activeCenterId;
  // The store scope whose tabs have been restored — tab changes before that
  // (the previous project's tabs closing) mustn't be saved over it.
  const restoredScope = useRef<string | null>(null);

  function snapshot(): PersistedOpenFiles {
    // One entry per file, even if a tab got opened twice somehow.
    const unique = tabsRef.current.filter((t, i, all) => all.findIndex((o) => o.path === t.path) === i);
    const files = unique.map((t) => {
      const view = getEditorView(t.path);
      if (!view) return { path: t.path };
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      return { path: t.path, line: line.number, column: head - line.from + 1 };
    });
    return { files, active: tabsRef.current.find((t) => t.id === activeRef.current)?.path };
  }

  useEffect(() => {
    if (store.scope.startsWith("loading")) return;
    let cancelled = false;
    (async () => {
      // Another project's clean tabs go; dirty ones are kept.
      for (const tab of tabsRef.current) if (!tab.dirty) await closeTab(tab.id);
      const saved = store.get(OPEN_FILES_KEY);
      if (isPersistedOpenFiles(saved)) {
        let activeId: string | null = null;
        const seen = new Set<string>();
        for (const file of saved.files) {
          // Older workspace files may list a tab twice.
          if (seen.has(file.path)) continue;
          seen.add(file.path);
          if (cancelled) return;
          const id = await open(
            { path: file.path, line: file.line, column: file.column },
            { silent: true, activate: false }
          );
          if (id && file.path === saved.active) activeId = id;
        }
        if (cancelled) return;
        if (activeId) await open({ path: saved.active! }, { silent: true });
      }
      restoredScope.current = store.scope;
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  // Saved when the set/order of tabs or the front one changes — not on
  // every edit (`tabs` changes with each keystroke).
  const tabPaths = tabs.map((t) => t.path).join("\n");
  useEffect(() => {
    if (restoredScope.current === store.scope) store.set(OPEN_FILES_KEY, snapshot());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabPaths, activeCenterId, store]);

  // Cursor positions change on every keystroke — gathered only when the
  // workspace is about to be written.
  useEffect(
    () =>
      addWorkspaceCollector((target) => {
        if (target === store && restoredScope.current === store.scope) target.set(OPEN_FILES_KEY, snapshot());
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store]
  );

  return null;
}
