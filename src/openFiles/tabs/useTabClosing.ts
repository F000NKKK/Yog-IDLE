// Closing tabs — asking about unsaved ones first — and pinning them.

import { useCallback } from "react";
import { forgetDocumentHistory } from "substrate-platform-ui";
import { askToSave } from "./tabViews";
import type { OpenTabs } from "./useOpenTabs";
import type { TabSaving } from "./useTabSaving";

/** Closing tabs — asking about unsaved ones first — and pinning them. */
export function useTabClosing(openTabs: OpenTabs, tabSaving: TabSaving) {
  const { setTabs, tabsRef, componentCache } = openTabs;
  const { save } = tabSaving;
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

  return { removeTabs, closeTab, confirmDiscard, confirmDiscardAll, closeTabs, closeAll, setPinned };
}

/** What `useTabClosing` gives the component. */
export type TabClosing = ReturnType<typeof useTabClosing>;
