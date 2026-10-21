import type { ReactNode } from "react";
import { OpenFilesContext } from "./openFiles/openFilesContext";
import { useOpenTabs } from "./openFiles/useOpenTabs";
import { useTabSaving } from "./openFiles/useTabSaving";
import { useTabClosing } from "./openFiles/useTabClosing";
import { useTabPaths } from "./openFiles/useTabPaths";
import { useDiskRecheck } from "./openFiles/useDiskRecheck";
import { useTabPanels } from "./openFiles/useTabPanels";
import { useLiveChecks } from "./diagnostics/liveCheck";

/** The open files: their tabs, editors and dock panels, saved, closed, and kept in step with the disk. */
export function OpenFilesProvider(props: { children: ReactNode }) {
  const { children } = props;
  const openTabs = useOpenTabs();
  const tabSaving = useTabSaving(openTabs);
  const tabClosing = useTabClosing(openTabs, tabSaving);
  const tabPaths = useTabPaths(openTabs, tabClosing);
  const diskRecheck = useDiskRecheck(openTabs, tabPaths);
  const tabPanels = useTabPanels(openTabs, tabClosing, tabPaths);
  const { tabs, tabsRef, open } = openTabs;
  useLiveChecks(tabs);
  const { updateContent, setSideState, save, saveAs, saveAll } = tabSaving;
  const { removeTabs, closeTab, confirmDiscardAll, closeTabs, closeAll, setPinned } = tabClosing;
  const { setView, pathRenamed, pathRemoved } = tabPaths;
  const { recheckDisk } = diskRecheck;
  const { rememberedViews, chooseView, panels, hasDirty } = tabPanels;

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
        chooseView,
        rememberedViews,
        panels,
      }}
    >
      {children}
    </OpenFilesContext.Provider>
  );
}

export { OpenFilesContext, useActiveFileTab, useOpenFiles, useOpenFilesIfAny } from "./openFiles/openFilesContext";
export type { FileTab, OpenFilesContextValue, SideState } from "./openFiles/openFilesContext";
