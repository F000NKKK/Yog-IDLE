// Editing and saving tabs: their text, an editor's side state, Save, Save As, Save All.

import { useCallback, useRef } from "react";
import { fileNameOf, reportError, t } from "substrate-platform-ui";
import { files } from "../../project/files";
import { invalidateDesignResources } from "../../lang/designResources";
import type { SideState } from "../openFilesContext";
import { regenerateScreen } from "./tabViews";
import type { OpenTabs } from "./useOpenTabs";

/** Editing and saving tabs: their text, an editor's side state, Save, Save As, Save All. */
export function useTabSaving(openTabs: OpenTabs) {
  const { setTabs, tabsRef } = openTabs;
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

  return { updateContent, sideSaves, setSideState, save, saveAs, saveAll };
}

/** What `useTabSaving` gives the component. */
export type TabSaving = ReturnType<typeof useTabSaving>;
