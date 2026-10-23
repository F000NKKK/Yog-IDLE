// What an operation acts on: the root, a node's folder, the selection, names already taken.

import { fileNameOf, type FileTreeNode } from "substrate-platform-ui";
import { files } from "../../../project/files";
import { parentOf } from "../../../project/paths";
import { findNode } from "../projectTree";
import type { ExplorerTreeView } from "../useExplorerTreeView";

/** What an operation acts on: the root, a node's folder, the selection, names already taken. */
export function useExplorerTargets(explorerTreeView: ExplorerTreeView) {
  const { scopeRoot, selectedIds, setRevision, expandedIds, onExpandedChange, shownNodes } = explorerTreeView;
  const changedDisk = () => setRevision((n) => n + 1);

  const rootNode = (): FileTreeNode => findNode(shownNodes, scopeRoot) ?? { id: scopeRoot, name: fileNameOf(scopeRoot), kind: "folder" };
  const isRoot = (node: FileTreeNode) => node.id === scopeRoot;
  /** Where Add/Paste on `node` puts things — the folder itself, or a file's folder. */
  const folderOf = (node: FileTreeNode) => (node.kind === "folder" ? node.id : parentOf(node.id));
  /** What an action on `node` covers: the whole selection when `node` is part of it. */
  const targetsOf = (node: FileTreeNode) =>
    selectedIds.has(node.id) && selectedIds.size > 1 ? [...selectedIds].filter((id) => id !== scopeRoot) : [node.id];

  function expand(folder: string) {
    if (!expandedIds.has(folder)) onExpandedChange(new Set([...expandedIds, folder]));
  }

  async function takenNames(folder: string): Promise<Set<string>> {
    const entries = await files.list(folder);
    return new Set(entries.map((e) => e.name.toLowerCase()));
  }

  return { changedDisk, rootNode, isRoot, folderOf, targetsOf, expand, takenNames };
}

/** What `useExplorerTargets` gives. */
export type ExplorerTargets = ReturnType<typeof useExplorerTargets>;
