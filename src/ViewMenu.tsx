import { MenuBarItem, useShell, useT } from "substrate-platform-ui";

/** View > one checked toggle per tool window — shows it (pinned where it last was) or hides it. */
export function ViewMenu() {
  const t = useT();
  const { toolWindows, isToolWindowVisible, showToolWindow, hideToolWindow } = useShell();
  return (
    <MenuBarItem
      label={t("View")}
      items={toolWindows.map(({ id, title }) => {
        const visible = isToolWindowVisible(id);
        return { label: title, checked: visible, onClick: () => (visible ? hideToolWindow(id) : showToolWindow(id)) };
      })}
    />
  );
}
