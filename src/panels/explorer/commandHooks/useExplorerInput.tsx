// Keys, the background menu, and the toolbar's buttons and filters.

import type { KeyboardEvent, MouseEvent } from "react";
import { type ContextMenuItem, type FileTreeMenuItem, type FileTreeNode, matchesShortcut, ToolbarButton } from "substrate-platform-ui";
import { boundCommands, commandLabel, explorerCommand, type ExplorerCommandId } from "../commands";
import type { ExplorerOperations } from "../useExplorerOperations";
import type { ExplorerTreeView } from "../useExplorerTreeView";
import type { ExplorerRun } from "./useExplorerRun";

/** Keys, the background menu, and the toolbar's buttons and filters. */
export function useExplorerInput(explorerTreeView: ExplorerTreeView, explorerOperations: ExplorerOperations, explorerRun: ExplorerRun) {
  const { git, listFilter, backgroundMenu, filtered } = explorerTreeView;
  const { rootNode, toggleFilter, focusedNode } = explorerOperations;
  const { run } = explorerRun;
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    const hit = boundCommands(false).find(([, command]) => matchesShortcut(e.nativeEvent, command.shortcut));
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    run[hit[0]](focusedNode());
  }

  /** Right-click below the rows: the root node's menu, as in Solution Explorer (not the webview's own). */
  function handleBackgroundContextMenu(e: MouseEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    backgroundMenu.openAtPoint(rootNode(), e);
  }

  const backgroundItems = (items: FileTreeMenuItem[], node: FileTreeNode): ContextMenuItem[] =>
    items.map(({ onSelect, submenu, ...item }) => ({
      ...item,
      onSelect: onSelect && (() => onSelect(node)),
      submenu: submenu && backgroundItems(submenu, node),
    }));

  /** A toolbar button for a command — its icon, name and shortcut from the table. */
  function button(id: ExplorerCommandId, extra: { active?: boolean; disabled?: boolean; dropdown?: boolean; onClick?: (e: MouseEvent<HTMLButtonElement>) => void } = {}) {
    const command = explorerCommand(id);
    return <ToolbarButton key={id} icon={command.icon} label={commandLabel(id)} shortcut={command.shortcut} onClick={() => run[id](focusedNode())} {...extra} />;
  }

  const filterItems: ContextMenuItem[] = (["filterOpenFiles", "filterPendingChanges"] as const).map((id) => ({
    label: commandLabel(id),
    shortcut: explorerCommand(id).shortcut,
    checked: listFilter === id,
    disabled: id === "filterPendingChanges" && !git.status,
    onSelect: () => toggleFilter(id),
  }));

  const searchCommand = explorerCommand("search");
  const empty = filtered && filtered.nodes.length === 0;

  return { handleKeyDown, handleBackgroundContextMenu, backgroundItems, button, filterItems, searchCommand, empty };
}

/** What `useExplorerInput` gives. */
export type ExplorerInput = ReturnType<typeof useExplorerInput>;
