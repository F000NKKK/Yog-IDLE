// The tabs as dock panels: titles, view buttons, tab menus and their cached editors.

import type { ComponentType } from "react";
import { EDITOR_KIND, editorProviderIcon, extensionOf, formatShortcut, type PanelAction, type PanelDef, t } from "substrate-platform-ui";
import { FileEditorPanel } from "../FileEditorPanel";
import type { FileTab } from "../openFilesContext";
import { tabMenu } from "./tabMenu";
import { isViewMap, PREVIEW_SIDE_ICON, PREVIEW_SIDE_KEYS, tabViews, TOGGLE_PREVIEW_KEYS, VIEWS_KEY } from "./tabViews";
import type { OpenTabs } from "./useOpenTabs";
import type { TabClosing } from "./useTabClosing";
import type { TabPaths } from "./useTabPaths";

/** The tabs as dock panels: titles, view buttons, tab menus and their cached editors. */
export function useTabPanels(openTabs: OpenTabs, tabClosing: TabClosing, tabPaths: TabPaths) {
  const { tabs, tabsRef, componentCache, globalStore } = openTabs;
  const { setPinned } = tabClosing;
  const { setView } = tabPaths;
  function getComponent(tabId: string): ComponentType {
    let component = componentCache.current.get(tabId);
    if (!component) {
      component = () => <FileEditorPanel tabId={tabId} />;
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
    const textView = providers.find((p) => p.kind === EDITOR_KIND.text);
    return providers.map((p) => {
      const icon = editorProviderIcon(p);
      const keys = icon === PREVIEW_SIDE_ICON ? PREVIEW_SIDE_KEYS : p === textView || p === providers.find((o) => o.kind !== EDITOR_KIND.text) ? TOGGLE_PREVIEW_KEYS : "";
      const shortcut = keys ? ` (${formatShortcut(keys)})` : "";
      return {
        id: p.id,
        icon,
        title: `${t(p.kind === EDITOR_KIND.text && icon !== PREVIEW_SIDE_ICON ? "Show {view}" : "Open {view}", { view: t(p.label) })}${shortcut}`,
        active: p === active,
        onClick: () => chooseView(tab.id, p.id),
      };
    });
  }

  const panels: PanelDef[] = tabs.map((tab) => ({
    id: tab.id,
    title: `${tab.name}${tab.missing ? ` ${t("(deleted)")}` : ""}${tab.dirty ? " •" : ""}`,
    tooltip: tab.path,
    pinned: tab.pinned,
    onUnpin: () => setPinned(tab.id, false),
    contextMenu: (context) => tabMenu(tab, context, { tabs: tabsRef.current, currentView: tabViews(tab, rememberedViews()).active.id, closing: tabClosing, setView }),
    actions: viewActions(tab),
    component: getComponent(tab.id),
  }));
  const hasDirty = tabs.some((t) => t.dirty);

  return { getComponent, rememberedViews, chooseView, viewActions, panels, hasDirty };
}

/** What `useTabPanels` gives the component. */
export type TabPanels = ReturnType<typeof useTabPanels>;
