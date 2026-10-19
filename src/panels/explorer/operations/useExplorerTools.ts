// Refresh, the search box, the list filters, the focused node.

import { type FileTreeNode, refreshGit } from "substrate-platform-ui";
import type { ListFilter } from "../explorerModel";
import { findNode } from "../projectTree";
import type { ExplorerTreeView } from "../useExplorerTreeView";
import type { ExplorerTargets } from "./useExplorerTargets";

/** Refresh, the search box, the list filters, the focused node. */
export function useExplorerTools(explorerTreeView: ExplorerTreeView, explorerTargets: ExplorerTargets) {
  const { tree, selectedIds, setListFilter, searchRef, shownNodes } = explorerTreeView;
  const { changedDisk, rootNode } = explorerTargets;
  async function refresh() {
    await tree.refreshAll();
    changedDisk();
    void refreshGit();
  }

  function focusSearch() {
    searchRef.current?.focus();
    searchRef.current?.select();
  }

  function toggleFilter(filter: ListFilter) {
    setListFilter((current) => (current === filter ? null : filter));
  }

  /** The node keyboard commands act on — the last selected one, else the root. */
  function focusedNode(): FileTreeNode {
    const id = [...selectedIds].pop();
    return (id !== undefined && findNode(shownNodes, id)) || rootNode();
  }

  return { refresh, focusSearch, toggleFilter, focusedNode };
}

/** What `useExplorerTools` gives. */
export type ExplorerTools = ReturnType<typeof useExplorerTools>;
