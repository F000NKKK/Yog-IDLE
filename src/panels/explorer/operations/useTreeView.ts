// The tree's view: Properties, collapsing, opening outside, scoping, following the active file.

import { useEffect } from "react";
import { errorText, type FileTreeNode, openPath, openTerminalIn, reportError, revealPath } from "substrate-platform-ui";
import { selectPath } from "../../../ideSelection";
import { isWithin } from "../../../paths";
import { openProjectProperties } from "../../../projectProperties/bus";
import type { ExplorerTreeProps } from "../../ProjectExplorer";
import { pathTo } from "../projectTree";
import type { ExplorerTreeView } from "../useExplorerTreeView";

/** The tree's view: Properties, collapsing, opening outside, scoping, following the active file. */
export function useTreeView(props: ExplorerTreeProps, explorerTreeView: ExplorerTreeView) {
  const { project } = props;
  const { shell, setScopes, scopeRoot, tree, activeTab, setSelectedIds, setQuery, setListFilter, trackActive, setReveal, pendingReveal, setPendingReveal, filtering, expandedIds, onExpandedChange, shownNodes, publishSelection } = explorerTreeView;
  function showProperties(node: FileTreeNode) {
    if (node.id === project.root && project.kind === "yog-mod") return openProjectProperties();
    selectPath(node.id, node.kind, "explorer");
    shell.showToolWindow("properties");
  }

  function collapseDescendants(node: FileTreeNode) {
    onExpandedChange(new Set([...expandedIds].filter((id) => id === node.id || !isWithin(id, node.id))));
  }

  /** Solution Explorer's "Collapse All": every folder closes, the root node stays open. */
  function collapseAll() {
    onExpandedChange(new Set([scopeRoot]));
  }

  function openInTerminal(folder: string) {
    shell.showToolWindow("terminal");
    openTerminalIn(folder);
  }

  function openInFileExplorer(node: FileTreeNode) {
    void (node.kind === "folder" ? openPath(node.id) : revealPath(node.id)).catch((err) => reportError(errorText(err)));
  }

  const relativePath = (path: string) => path.slice(project.root.replace(/[/\\]+$/, "").length + 1) || ".";

  /** Scope to This: the tree rooted at `folder`, Back returning to where it was. */
  function scopeTo(folder: string) {
    if (folder === scopeRoot) return;
    setQuery("");
    setListFilter(null);
    setScopes(({ stack, at }) => ({ stack: [...stack.slice(0, at + 1), folder], at: at + 1 }));
  }

  /**
   * Sync with Active Document: the file's folders opened and its row
   * selected and scrolled to. A search or filter hiding it is cleared.
   */
  function syncTo(path: string, select: boolean) {
    if (!isWithin(path, scopeRoot)) return;
    if (filtering && !pathTo(shownNodes, path)) {
      setQuery("");
      setListFilter(null);
    }
    setPendingReveal({ path, listed: false, select });
    void tree.revealPath(path).then(() => setPendingReveal((p) => (p?.path === path ? { ...p, listed: true } : p)));
  }

  useEffect(() => {
    if (!pendingReveal) return;
    const chain = pathTo(shownNodes, pendingReveal.path);
    if (!chain) {
      // Not in the tree (hidden, not part of the project) once its folders are listed: nothing to show.
      if (pendingReveal.listed) setPendingReveal(null);
      return;
    }
    const closed = chain.filter((id) => !expandedIds.has(id));
    if (closed.length > 0) onExpandedChange(new Set([...expandedIds, ...closed]));
    const ids = new Set([pendingReveal.path]);
    setSelectedIds(ids);
    if (pendingReveal.select) publishSelection(ids);
    setReveal({ id: pendingReveal.path });
    setPendingReveal(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReveal, shownNodes]);

  // Track Active Item: the tree follows the editor — without taking Properties over from it.
  const activePath = activeTab?.path;
  useEffect(() => {
    if (trackActive && activePath) syncTo(activePath, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackActive, activePath]);

  return { showProperties, collapseDescendants, collapseAll, openInTerminal, openInFileExplorer, relativePath, scopeTo, syncTo, activePath };
}

/** What `useTreeView` gives. */
export type TreeView = ReturnType<typeof useTreeView>;
