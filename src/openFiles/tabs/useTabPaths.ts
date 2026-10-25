// A tab's view, and tabs following their files: renamed, deleted.

import { useCallback, useEffect } from "react";
import { addCloseGuard, EDITOR_KIND, editorProviderById, fileNameOf, notify, reportError, t } from "substrate-platform-ui";
import { files } from "../../project/files";
import { isWithin } from "../../project/paths";
import type { FileTab } from "../openFilesValue";
import type { OpenTabs } from "./useOpenTabs";
import type { TabClosing } from "./useTabClosing";

/** A tab's view, and tabs following their files: renamed, deleted. */
export function useTabPaths(openTabs: OpenTabs, tabClosing: TabClosing) {
  const { setTabs, tabsRef, setViewRef } = openTabs;
  const { removeTabs, confirmDiscardAll } = tabClosing;
  const setView = useCallback(async (id: string, view: string) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!tab) return;
    // A text editor picked for a file opened only as binary needs its text first.
    if (!tab.textLoaded && editorProviderById(view)?.kind !== EDITOR_KIND.binary) {
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

  return { setView, pathRenamed, markGone, pathRemoved };
}

/** What `useTabPaths` gives the component. */
export type TabPaths = ReturnType<typeof useTabPaths>;
