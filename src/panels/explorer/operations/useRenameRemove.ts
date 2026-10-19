// Renaming and deleting items.

import { confirmDialog, type FileTreeNode, reportError, t } from "substrate-platform-ui";
import { files } from "../../../files";
import { renamePath, selectionPathRemoved } from "../../../ideSelection";
import { isWithin, parentOf, validateEntryName as validateName } from "../../../paths";
import { attempt } from "../explorerModel";
import { findNode } from "../projectTree";
import type { ExplorerTreeView } from "../useExplorerTreeView";
import type { AddItems } from "./useAddItems";
import type { ExplorerTargets } from "./useExplorerTargets";

/** Renaming and deleting items. */
export function useRenameRemove(explorerTreeView: ExplorerTreeView, explorerTargets: ExplorerTargets, addItems: AddItems) {
  const { scopeRoot, tree, pathRenamed, pathRemoved, setSelectedIds, editing, setEditing, shownNodes } = explorerTreeView;
  const { changedDisk, isRoot, targetsOf } = explorerTargets;
  const { addPlain } = addItems;
  function startRename(node: FileTreeNode) {
    if (isRoot(node) || node.generated) return;
    setEditing({ kind: "rename", id: node.id });
  }

  async function commitEdit(node: FileTreeNode, text: string) {
    const current = editing;
    setEditing(null);
    if (!current) return;
    const name = text.trim();
    const problem = validateName(text);
    if (current.kind === "new") {
      if (problem === "") return;
      if (problem) return reportError(problem);
      await addPlain(current.folder, name, current.isFolder);
      return;
    }
    if (problem === "" || name === node.name) return;
    if (problem) return reportError(problem);
    // Open tabs and the selection under the old path follow it to the new one.
    await attempt(t("Failed to rename {name}", { name: node.name }), async () => {
      await renamePath(node.id, name, pathRenamed);
      changedDisk();
      // Another view's rename doesn't go through this tree's `renameNode`.
      await tree.reload(parentOf(node.id));
    });
  }

  async function remove(node: FileTreeNode) {
    const ids = targetsOf(node).filter((id) => id !== scopeRoot && !findNode(shownNodes, id)?.generated);
    if (ids.length === 0) return;
    const only = ids.length === 1 ? findNode(shownNodes, ids[0]) ?? node : null;
    const confirmed = await confirmDialog({
      title: only ? (only.kind === "folder" ? t("Delete Folder") : t("Delete File")) : t("Delete"),
      message: only
        ? only.kind === "folder"
          ? t('Delete "{name}" and everything in it?', { name: only.name })
          : t('Delete "{name}"?', { name: only.name })
        : t("Delete {count} items?", { count: ids.length }),
      confirmLabel: t("Delete"),
    });
    if (!confirmed) return;
    for (const id of ids) {
      const target = findNode(tree.nodes, id) ?? findNode(shownNodes, id);
      if (!target) continue;
      await attempt(t("Failed to delete {name}", { name: target.name }), async () => {
        if (findNode(tree.nodes, id)) await tree.removeNode(target);
        else {
          await files.remove(id);
          await tree.reload(parentOf(id));
        }
        pathRemoved(target.id);
        selectionPathRemoved(target.id);
        setSelectedIds((prev) => new Set([...prev].filter((sel) => !isWithin(sel, target.id))));
      });
    }
    changedDisk();
  }

  return { startRename, commitEdit, remove };
}

/** What `useRenameRemove` gives. */
export type RenameRemove = ReturnType<typeof useRenameRemove>;
