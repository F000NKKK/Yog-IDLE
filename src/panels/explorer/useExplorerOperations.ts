// What Project Explorer does to files: add, paste, rename, delete, scope, follow the editor.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect } from "react";
import { confirmDialog, errorText, fileNameOf, type FileTreeNode, joinPath, openFile, openPath, openTerminalIn, refreshGit, reportError, revealPath, t } from "substrate-platform-ui";
import { files } from "../../files";
import { renamePath, selectionPathRemoved, selectionPathRenamed, selectPath } from "../../ideSelection";
import { isWithin, parentOf, validateEntryName as validateName } from "../../paths";
import { openProjectProperties } from "../../projectProperties/bus";
import { type ItemTemplate, templateFiles } from "../NewItemDialog";
import { attempt, copyName, explorerClipboard, type ListFilter, modIdOf, setExplorerClipboard } from "./explorerModel";
import { findNode, pathTo, placeholderId } from "./projectTree";
import type { ExplorerView } from "./useExplorerView";
import type { ExplorerTreeProps } from "../ProjectExplorer";

/** What Project Explorer does to files: add, paste, rename, delete, scope, follow the editor. */
export function useExplorerOperations(props: ExplorerTreeProps, explorerView: ExplorerView) {
  const { project } = props;
  const { shell, setScopes, scopeRoot, tree, pathRenamed, pathRemoved, activeTab, selectedIds, setSelectedIds, editing, setEditing, setQuery, setListFilter, trackActive, setRevision, setClipboardSeq, setReveal, pendingReveal, setPendingReveal, searchRef, entries, only, filtering, expandedIds, onExpandedChange, clip, shownNodes, publishSelection } = explorerView;
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

  async function addFromTemplate(folder: string, template: ItemTemplate, name: string) {
    const modId = await modIdOf(project);
    if (template.rootFolder && folder === project.root) {
      // `.yres` files live in `resources/`, as a C# project's `.resx` in `Resources/`.
      const inner = joinPath(project.root, template.rootFolder);
      if (!(await takenNames(project.root)).has(template.rootFolder.toLowerCase())) await files.createDir(inner);
      await tree.reload(project.root);
      folder = inner;
    }
    const src = joinPath(project.root, "src");
    const srcDir = isWithin(folder, src) ? folder.slice(src.length + 1).replace(/\\/g, "/") : "";
    const created = templateFiles(template, name, { modId, srcDir });
    await attempt(t("Failed to create {name}", { name }), async () => {
      for (const [file, made] of created) {
        const path = joinPath(folder, file);
        const contents = await made;
        await files.createFile(path);
        if (contents) await files.write(path, contents);
      }
      await tree.reload(folder);
      changedDisk();
      expand(folder);
      // The first file is the one to work on (the screen, not its code-behind).
      openFile({ path: joinPath(folder, created[0][0]), name: created[0][0] });
    });
  }

  async function addPlain(folder: string, name: string, isFolder: boolean) {
    await attempt(t("Failed to create {name}", { name }), async () => {
      if (isFolder) await tree.createDirIn(folder, name);
      else {
        await tree.createFileIn(folder, name);
        openFile({ path: joinPath(folder, name), name });
      }
      changedDisk();
      expand(folder);
      const path = joinPath(folder, name);
      setSelectedIds(new Set([path]));
      setReveal({ id: path });
    });
  }

  /** New File / New Folder: an empty row in `folder` to type the name into. */
  function startNew(folder: string, isFolder: boolean) {
    if (filtering) {
      // The row goes into the full tree; the search or filter would hide it.
      setQuery("");
      setListFilter(null);
      void tree.revealPath(placeholderId(folder));
    } else expand(folder);
    setEditing({ kind: "new", folder, isFolder });
    setReveal({ id: placeholderId(folder) });
  }

  /** Add > Existing Item (Shift+Alt+A): copies files picked from anywhere into `folder`. */
  async function addExisting(folder: string) {
    const picked = await openDialog({ multiple: true, title: t("Add Existing Item") });
    const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;
    await attempt(t("Failed to add files"), async () => {
      const taken = await takenNames(folder);
      for (const from of paths) {
        const name = copyName(fileNameOf(from), taken);
        taken.add(name.toLowerCase());
        await files.copy(from, joinPath(folder, name));
      }
      await tree.reload(folder);
      changedDisk();
      expand(folder);
    });
  }

  /** Moves (or with `copy`, copies) `paths` into `folder` — Paste after Cut/Copy, Duplicate, and drag and drop. */
  async function transfer(paths: string[], folder: string, copy: boolean) {
    await attempt(copy ? t("Failed to copy") : t("Failed to move"), async () => {
      const taken = await takenNames(folder);
      const touched = new Set([folder]);
      for (const from of paths) {
        if (!copy && isWithin(folder, from)) throw new Error(t("Can't move a folder into itself."));
        if (copy) {
          const name = copyName(fileNameOf(from), taken);
          taken.add(name.toLowerCase());
          await files.copy(from, joinPath(folder, name));
          continue;
        }
        if (parentOf(from) === folder.replace(/[/\\]+$/, "")) continue;
        const name = fileNameOf(from);
        if (taken.has(name.toLowerCase())) throw new Error(t('"{name}" already exists.', { name }));
        const to = joinPath(folder, name);
        await files.rename(from, to);
        taken.add(name.toLowerCase());
        touched.add(parentOf(from));
        // Open tabs and the selection follow it to the new place.
        pathRenamed(from, to);
        selectionPathRenamed(from, to);
        setSelectedIds((prev) => new Set([...prev].map((id) => (isWithin(id, from) ? to + id.slice(from.length) : id))));
      }
      for (const dir of touched) await tree.reload(dir);
      changedDisk();
      expand(folder);
    });
  }

  function putOnClipboard(node: FileTreeNode, cut: boolean) {
    if (isRoot(node) || node.generated) return;
    setExplorerClipboard({ paths: targetsOf(node), cut });
    setClipboardSeq((n) => n + 1);
  }

  async function paste(node: FileTreeNode) {
    const clip = explorerClipboard;
    if (!clip) return;
    // Cut moves once; Copy can paste again.
    if (clip.cut) {
      setExplorerClipboard(null);
      setClipboardSeq((n) => n + 1);
    }
    await transfer(clip.paths, folderOf(node), !clip.cut);
  }

  /** Duplicate: a copy of each item next to it, named as a pasted copy is. */
  async function duplicate(node: FileTreeNode) {
    if (isRoot(node) || node.generated) return;
    const byFolder = new Map<string, string[]>();
    for (const path of targetsOf(node)) byFolder.set(parentOf(path), [...(byFolder.get(parentOf(path)) ?? []), path]);
    for (const [folder, paths] of byFolder) await transfer(paths, folder, true);
  }

  /** F2: the name becomes editable in place. */
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

  return { changedDisk, rootNode, isRoot, folderOf, targetsOf, expand, takenNames, addFromTemplate, addPlain, startNew, addExisting, transfer, putOnClipboard, paste, duplicate, startRename, commitEdit, remove, showProperties, collapseDescendants, collapseAll, openInTerminal, openInFileExplorer, relativePath, scopeTo, syncTo, activePath, refresh, focusSearch, toggleFilter, focusedNode };
}

/** What `useExplorerOperations` gives the component. */
export type ExplorerOperations = ReturnType<typeof useExplorerOperations>;
