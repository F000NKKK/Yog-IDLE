// What Project Explorer does to files: add, paste, rename, delete, scope, follow the editor.

import type { ExplorerTreeView } from "./useExplorerTreeView";
import type { ExplorerTreeProps } from "../ProjectExplorer";
import { useExplorerTargets } from "./operations/useExplorerTargets";
import { useAddItems } from "./operations/useAddItems";
import { useClipboardItems } from "./operations/useClipboardItems";
import { useRenameRemove } from "./operations/useRenameRemove";
import { useTreeView } from "./operations/useTreeView";
import { useExplorerTools } from "./operations/useExplorerTools";

/** What Project Explorer does to files: add, paste, rename, delete, scope, follow the editor. */
export function useExplorerOperations(props: ExplorerTreeProps, explorerTreeView: ExplorerTreeView) {
  const explorerTargets = useExplorerTargets(explorerTreeView);
  const addItems = useAddItems(props, explorerTreeView, explorerTargets);
  const clipboardItems = useClipboardItems(explorerTreeView, explorerTargets);
  const renameRemove = useRenameRemove(explorerTreeView, explorerTargets, addItems);
  const treeView = useTreeView(props, explorerTreeView);
  const explorerTools = useExplorerTools(explorerTreeView, explorerTargets);
  const { changedDisk, rootNode, isRoot, folderOf, targetsOf, expand, takenNames } = explorerTargets;
  const { addFromTemplate, addPlain, startNew, addExisting } = addItems;
  const { transfer, putOnClipboard, paste, duplicate } = clipboardItems;
  const { startRename, commitEdit, remove } = renameRemove;
  const { showProperties, collapseDescendants, collapseAll, openInTerminal, openInFileExplorer, relativePath, scopeTo, syncTo, activePath } = treeView;
  const { refresh, focusSearch, toggleFilter, focusedNode } = explorerTools;
  return { changedDisk, rootNode, isRoot, folderOf, targetsOf, expand, takenNames, addFromTemplate, addPlain, startNew, addExisting, transfer, putOnClipboard, paste, duplicate, startRename, commitEdit, remove, showProperties, collapseDescendants, collapseAll, openInTerminal, openInFileExplorer, relativePath, scopeTo, syncTo, activePath, refresh, focusSearch, toggleFilter, focusedNode };
}

/** What `useExplorerOperations` gives the component. */
export type ExplorerOperations = ReturnType<typeof useExplorerOperations>;
