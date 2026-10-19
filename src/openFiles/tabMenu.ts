import { type ContextMenuItem, reportError, t, type TabMenuContext } from "substrate-platform-ui";
import type { FileTab } from "./openFilesContext";
import { openWithItems } from "./tabViews";
import type { TabClosing } from "./useTabClosing";

/** What a tab's menu acts on: every tab, the view it shows, closing, and Open With. */
interface TabMenuDeps {
  tabs: readonly FileTab[];
  currentView: string;
  closing: TabClosing;
  setView: (id: string, view: string) => Promise<void>;
}

/** A file tab's context menu: closing it and others, pinning, copying its path, Open With. */
export function tabMenu(tab: FileTab, { centerIds }: TabMenuContext, { tabs, currentView, closing, setView }: TabMenuDeps): ContextMenuItem[] {
  const { closeTab, closeTabs, closeAll, setPinned } = closing;
  const fileIds = new Set(tabs.map((t) => t.id));
  const unpinned = (ids: string[]) => ids.filter((id) => fileIds.has(id) && !tabs.find((t) => t.id === id)?.pinned);
  const toTheRight = unpinned(centerIds.slice(centerIds.indexOf(tab.id) + 1));
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
      submenu: openWithItems(tab.path, currentView, (view) => void setView(tab.id, view)),
    },
  ];
}
