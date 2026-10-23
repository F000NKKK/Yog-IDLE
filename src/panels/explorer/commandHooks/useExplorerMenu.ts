// A node's context menu.

import { type FileTreeMenuItem, type FileTreeNode, openFile } from "substrate-platform-ui";
import { openWithItems } from "../../../openFiles/tabs/tabViews";
import { parentOf } from "../../../project/paths";
import type { ExplorerTreeProps } from "../../ProjectExplorer";
import { codeBehindPair, explorerClipboard } from "../explorerModel";
import { placeholderId } from "../projectTree";
import type { ExplorerOperations } from "../useExplorerOperations";
import type { ExplorerTreeView } from "../useExplorerTreeView";
import type { ExplorerRun } from "./useExplorerRun";
import type { ViewSwitch } from "./useViewSwitch";

/** A node's context menu. */
export function useExplorerMenu(props: ExplorerTreeProps, explorerTreeView: ExplorerTreeView, explorerOperations: ExplorerOperations, viewSwitch: ViewSwitch, explorerRun: ExplorerRun) {
  const { project } = props;
  const { tabs } = explorerTreeView;
  const { isRoot } = explorerOperations;
  const { designerView } = viewSwitch;
  const { item } = explorerRun;
  function getMenuItems(node: FileTreeNode): FileTreeMenuItem[] {
    if (node.id === placeholderId(parentOf(node.id))) return [];
    const root = isRoot(node);
    const items: FileTreeMenuItem[] = [];
    // Generated code isn't a project file: it can only be looked at.
    if (node.generated) {
      return [item("open", node), item("openContainingFolder", node, { separatorBefore: true }), item("copyFullPath", node)];
    }
    if (node.kind === "file") {
      items.push(item("open", node));
      const current = tabs.find((tab) => tab.path === node.id)?.view;
      items.push(item("openWith", node, { onSelect: undefined, submenu: openWithItems(node.id, current, (view) => openFile({ path: node.id, name: node.name, view })) }));
      // View Code (F7) / View Designer (Shift+F7): a screen's code-behind, else the file's own code or designer view.
      items.push(item("viewCode", node));
      if (codeBehindPair(node.id) || designerView(node.id)) items.push(item("viewDesigner", node));
    }
    if (node.id === project.root && project.kind === "yog-mod") {
      // Visual Studio's project node starts with Build/Clean.
      items.push(item("build", node));
      items.push(item("clean", node));
    }
    if (node.kind === "folder") {
      items.push(
        item("add", node, {
          onSelect: undefined,
          separatorBefore: items.length > 0,
          submenu: [
            item("newItem", node),
            item("quickAdd", node),
            item("addExisting", node),
            item("newFile", node, { separatorBefore: true }),
            item("newFolder", node),
          ],
        })
      );
      if (!root) items.push(item("scopeToThis", node));
      items.push(item("newView", node, { separatorBefore: root }));
    }
    items.push(item(node.kind === "folder" ? "openFolderInFileExplorer" : "openContainingFolder", node, { separatorBefore: true }));
    items.push(item("openInTerminal", node));
    if (!root) {
      items.push(item("cut", node, { separatorBefore: true }));
      items.push(item("copy", node));
    }
    items.push(item("paste", node, { separatorBefore: root, disabled: !explorerClipboard }));
    if (!root) {
      items.push(item("duplicate", node));
      items.push(item("delete", node, { destructive: true }));
      items.push(item("rename", node));
    }
    items.push(item("copyFullPath", node, { separatorBefore: true }));
    if (node.id !== project.root) items.push(item("copyRelativePath", node));
    if (node.kind === "folder") items.push(item("collapseDescendants", node, { separatorBefore: true }));
    items.push(item("collapseAll", node, { separatorBefore: node.kind !== "folder" }));
    items.push(item("properties", node, { separatorBefore: true }));
    return items;
  }

  /** A screen and its code-behind both in the tree. */

  return { getMenuItems };
}

/** What `useExplorerMenu` gives. */
export type ExplorerMenu = ReturnType<typeof useExplorerMenu>;
