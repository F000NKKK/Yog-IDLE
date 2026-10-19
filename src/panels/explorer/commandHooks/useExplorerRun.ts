// Each command's action, the shortcut chords, and build commands.

import { type FileTreeMenuItem, type FileTreeNode, type HostCommand, openFile, t } from "substrate-platform-ui";
import { commandLabel, explorerCommand, type ExplorerCommandId } from "../commands";
import { yog } from "../../../host.generated";
import { runModCommand } from "../../../runModCommand";
import type { ExplorerTreeProps } from "../../ProjectExplorer";
import { openExplorerView, PROJECT_EXPLORER_VIEW_PANEL, useExplorerRequests } from "../explorerBus";
import { copyText } from "../explorerModel";
import type { ExplorerOperations } from "../useExplorerOperations";
import type { ExplorerTreeView } from "../useExplorerTreeView";
import type { ViewSwitch } from "./useViewSwitch";

/** Each command's action, the shortcut chords, and build commands. */
export function useExplorerRun(props: ExplorerTreeProps, explorerTreeView: ExplorerTreeView, explorerOperations: ExplorerOperations, viewSwitch: ViewSwitch) {
  const { project, main = false } = props;
  const { shell, setScopes, setNewItem, setShowAllFiles, setTrackActive, setSearchContents } = explorerTreeView;
  const { folderOf, startNew, addExisting, putOnClipboard, paste, duplicate, startRename, remove, showProperties, collapseDescendants, collapseAll, openInTerminal, openInFileExplorer, relativePath, scopeTo, syncTo, activePath, refresh, focusSearch, toggleFilter, focusedNode } = explorerOperations;
  const { viewCode, viewDesigner } = viewSwitch;
  const run: Record<ExplorerCommandId, (node: FileTreeNode) => void> = {
    open: (n) => n.kind === "file" && openFile({ path: n.id, name: n.name }),
    openWith: () => {},
    viewCode: (n) => viewCode(n),
    viewDesigner: (n) => viewDesigner(n),
    build: () => void runBuild(yog.run.modBuild, t("Build")),
    clean: () => void runBuild(yog.run.modClean, t("Clean")),
    add: () => {},
    newItem: (n) => setNewItem({ folder: folderOf(n), full: true }),
    quickAdd: (n) => setNewItem({ folder: folderOf(n), full: false }),
    addExisting: (n) => void addExisting(folderOf(n)),
    newFile: (n) => startNew(folderOf(n), false),
    newFolder: (n) => startNew(folderOf(n), true),
    scopeToThis: (n) => n.kind === "folder" && scopeTo(n.id),
    newView: (n) => {
      openExplorerView(folderOf(n));
      shell.showToolWindow(PROJECT_EXPLORER_VIEW_PANEL);
    },
    openFolderInFileExplorer: openInFileExplorer,
    openContainingFolder: openInFileExplorer,
    openInTerminal: (n) => openInTerminal(folderOf(n)),
    cut: (n) => putOnClipboard(n, true),
    copy: (n) => putOnClipboard(n, false),
    paste: (n) => void paste(n),
    duplicate: (n) => void duplicate(n),
    delete: (n) => void remove(n),
    rename: startRename,
    copyFullPath: (n) => void copyText(n.id),
    copyRelativePath: (n) => void copyText(relativePath(n.id)),
    collapseDescendants,
    collapseAll,
    properties: showProperties,
    back: () => setScopes((s) => ({ ...s, at: Math.max(0, s.at - 1) })),
    forward: () => setScopes((s) => ({ ...s, at: Math.min(s.stack.length - 1, s.at + 1) })),
    home: () => scopeTo(project.root),
    syncActive: () => activePath && syncTo(activePath, true),
    trackActive: () => setTrackActive((on) => !on),
    showAllFiles: () => setShowAllFiles((on) => !on),
    filters: () => {},
    filterOpenFiles: () => toggleFilter("filterOpenFiles"),
    filterPendingChanges: () => toggleFilter("filterPendingChanges"),
    refresh: () => void refresh(),
    search: focusSearch,
    searchContents: () => setSearchContents((on) => !on),
  };

  // Ctrl+; and the Ctrl+[ chords, pressed anywhere — for the main view.
  useExplorerRequests((id) => {
    // After the window has come up and laid out.
    requestAnimationFrame(() => run[id](focusedNode()));
  }, main);

  const runBuild = (command: HostCommand, what: string) => runModCommand(command, project.root, what);

  /** A menu entry for a command — its name and shortcut from the table, run on `node`. */
  function item(id: ExplorerCommandId, node: FileTreeNode, extra: Partial<FileTreeMenuItem> = {}): FileTreeMenuItem {
    return { label: commandLabel(id), shortcut: explorerCommand(id).shortcut, onSelect: () => run[id](node), ...extra };
  }

  return { run, runBuild, item };
}

/** What `useExplorerRun` gives. */
export type ExplorerRun = ReturnType<typeof useExplorerRun>;
