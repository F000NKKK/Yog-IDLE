// Copying, cutting, pasting and duplicating items.

import { fileNameOf, type FileTreeNode, joinPath, t } from "substrate-platform-ui";
import { files } from "../../../project/files";
import { selectionPathRenamed } from "../../../app/ideSelection";
import { isWithin, parentOf } from "../../../project/paths";
import { attempt, copyName, explorerClipboard, setExplorerClipboard } from "../explorerModel";
import type { ExplorerTreeView } from "../useExplorerTreeView";
import type { ExplorerTargets } from "./useExplorerTargets";

/** Copying, cutting, pasting and duplicating items. */
export function useClipboardItems(explorerTreeView: ExplorerTreeView, explorerTargets: ExplorerTargets) {
  const { tree, pathRenamed, setSelectedIds, setClipboardSeq } = explorerTreeView;
  const { changedDisk, isRoot, folderOf, targetsOf, expand, takenNames } = explorerTargets;
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

  return { transfer, putOnClipboard, paste, duplicate };
}

/** What `useClipboardItems` gives. */
export type ClipboardItems = ReturnType<typeof useClipboardItems>;
