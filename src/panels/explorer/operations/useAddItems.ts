// Adding items: from a template, plain files and folders, existing files.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { fileNameOf, joinPath, openFile, t } from "substrate-platform-ui";
import { files } from "../../../files";
import { isWithin } from "../../../paths";
import { type ItemTemplate, templateFiles } from "../../NewItemDialog";
import type { ExplorerTreeProps } from "../../ProjectExplorer";
import { attempt, copyName, modIdOf } from "../explorerModel";
import { placeholderId } from "../projectTree";
import type { ExplorerTreeView } from "../useExplorerTreeView";
import type { ExplorerTargets } from "./useExplorerTargets";

/** Adding items: from a template, plain files and folders, existing files. */
export function useAddItems(props: ExplorerTreeProps, explorerTreeView: ExplorerTreeView, explorerTargets: ExplorerTargets) {
  const { project } = props;
  const { tree, setSelectedIds, setEditing, setQuery, setListFilter, setReveal, filtering } = explorerTreeView;
  const { changedDisk, expand, takenNames } = explorerTargets;
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

  return { addFromTemplate, addPlain, startNew, addExisting };
}

/** What `useAddItems` gives. */
export type AddItems = ReturnType<typeof useAddItems>;
