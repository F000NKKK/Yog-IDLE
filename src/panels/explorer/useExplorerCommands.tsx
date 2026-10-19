// Project Explorer's commands: what each does, its keys and its menus.

import { invoke } from "@tauri-apps/api/core";
import type { KeyboardEvent, MouseEvent } from "react";
import { type ContextMenuItem, editorProvidersFor, fileNameOf, type FileTreeMenuItem, type FileTreeNode, generalEditorProviders, matchesShortcut, openFile, reportError, t, ToolbarButton } from "substrate-platform-ui";
import { openWithItems } from "../../openFiles/tabViews";
import { parentOf } from "../../paths";
import { boundCommands, commandLabel, explorerCommand, type ExplorerCommandId } from "./commands";
import { openExplorerView, PROJECT_EXPLORER_VIEW_PANEL, useExplorerRequests } from "./explorerBus";
import { codeBehindPair, copyText, explorerClipboard } from "./explorerModel";
import { findNode, placeholderId } from "./projectTree";
import type { ExplorerOperations } from "./useExplorerOperations";
import type { ExplorerView } from "./useExplorerView";
import type { ExplorerTreeProps } from "../ProjectExplorer";

/** Project Explorer's commands: what each does, its keys and its menus. */
export function useExplorerCommands(props: ExplorerTreeProps, explorerView: ExplorerView, explorerOperations: ExplorerOperations) {
  const { project, main = false } = props;
  const { shell, setScopes, tabs, git, newItem, setNewItem, listFilter, showAllFiles, setShowAllFiles, trackActive, setTrackActive, searchContents, setSearchContents, backgroundMenu, projectItems, filtered, shownNodes } = explorerView;
  const { rootNode, isRoot, folderOf, startNew, addExisting, putOnClipboard, paste, duplicate, startRename, remove, showProperties, collapseDescendants, collapseAll, openInTerminal, openInFileExplorer, relativePath, scopeTo, syncTo, activePath, refresh, focusSearch, toggleFilter, focusedNode } = explorerOperations;
  /** What each command does to the node it's invoked on (the focused one, from the toolbar and the keyboard). */
  const run: Record<ExplorerCommandId, (node: FileTreeNode) => void> = {
    open: (n) => n.kind === "file" && openFile({ path: n.id, name: n.name }),
    openWith: () => {},
    viewCode: (n) => viewCode(n),
    viewDesigner: (n) => viewDesigner(n),
    build: () => void runBuild("mod_build", t("Build")),
    clean: () => void runBuild("mod_clean", t("Clean")),
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

  function runBuild(command: string, what: string) {
    return invoke(command, { projectRoot: project.root }).catch((err) => reportError(t("{action} failed to start: {error}", { action: what, error: String(err) })));
  }

  /** A menu entry for a command — its name and shortcut from the table, run on `node`. */
  function item(id: ExplorerCommandId, node: FileTreeNode, extra: Partial<FileTreeMenuItem> = {}): FileTreeMenuItem {
    return { label: commandLabel(id), shortcut: explorerCommand(id).shortcut, onSelect: () => run[id](node), ...extra };
  }

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
  function pairOf(node: FileTreeNode) {
    const pair = codeBehindPair(node.id);
    if (!pair) return null;
    const exists = (path: string) => !!findNode(shownNodes, path) || !!projectItems?.has(path);
    return exists(pair.screen) && exists(pair.code) ? pair : null;
  }

  /** The file's designer view (`.yui`, `.yblock`…), if it has one. */
  function designerView(path: string) {
    return editorProvidersFor(path).find((p) => p.kind === "designer");
  }

  /** F7, as in Visual Studio: a screen's code-behind, else the file in a code editor. */
  function viewCode(node: FileTreeNode) {
    if (node.kind !== "file") return;
    const pair = pairOf(node);
    if (pair && node.id === pair.screen) {
      openFile({ path: pair.code, name: fileNameOf(pair.code) });
      return;
    }
    const code = editorProvidersFor(node.id).find((p) => p.kind === "text") ?? generalEditorProviders().find((p) => p.kind === "text");
    openFile({ path: node.id, name: node.name, view: code?.id });
  }

  /** Shift+F7: a code-behind's screen, else the file's designer. */
  function viewDesigner(node: FileTreeNode) {
    if (node.kind !== "file") return;
    const pair = pairOf(node);
    if (pair && node.id === pair.code) {
      openFile({ path: pair.screen, name: fileNameOf(pair.screen) });
      return;
    }
    const designer = designerView(node.id);
    if (designer) openFile({ path: node.id, name: node.name, view: designer.id });
  }

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

  return { run, runBuild, item, getMenuItems, pairOf, designerView, viewCode, viewDesigner, handleKeyDown, handleBackgroundContextMenu, backgroundItems, button, filterItems, searchCommand, empty };
}

/** What `useExplorerCommands` gives the component. */
export type ExplorerCommands = ReturnType<typeof useExplorerCommands>;
