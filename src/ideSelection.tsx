// What Yog-IDLE publishes into substrate-platform-ui's global selection
// (`setSelection`), and the glue that keeps it — and Project Explorer —
// right when a selected file is renamed or deleted, whichever panel did it.
// The Properties window reads it back through `useSelection`.

import { activatePropertyContext, getCurrentSelection, setSelection, t } from "substrate-platform-ui";
import { isWithin, renamedPath } from "./paths";
import { files } from "./files";

export interface IdeSelectionData {
  path: string;
}

export type SelectionSource = "explorer" | "editor";

export function selectPath(path: string, kind: "file" | "folder", source: SelectionSource): void {
  setSelection({ id: path, kind, data: { path }, source });
}

/**
 * What focusing a document window shows in Properties, as in Visual
 * Studio: the window's own context (a designer's selected element) when it
 * has one, else its file.
 */
export function selectDocument(path: string): void {
  if (!activatePropertyContext(path)) selectPath(path, "file", "editor");
}

export function selectMultiple(count: number, source: SelectionSource): void {
  setSelection({ id: `multiple:${count}`, kind: "multiple", data: { path: "" }, source });
}

/** A rename (from Explorer or Properties) — a selection at or under `from` follows it to `to`. */
export function selectionPathRenamed(from: string, to: string): void {
  const current = getCurrentSelection<IdeSelectionData>();
  if (!current || current.kind === "multiple" || !isWithin(current.data.path, from)) return;
  const path = to + current.data.path.slice(from.length);
  setSelection({ ...current, id: path, data: { path } });
}

/** A delete — a selection at or under `path` is gone with it. */
export function selectionPathRemoved(path: string): void {
  const current = getCurrentSelection<IdeSelectionData>();
  if (current && current.kind !== "multiple" && isWithin(current.data.path, path)) setSelection(null);
}

/** Project Explorer's own rename (keeps its tree in step) — resolves `false` when `path` isn't in the loaded tree. */
type ExplorerRename = (path: string, newName: string) => Promise<boolean>;

let explorerRename: ExplorerRename | null = null;

/** Project Explorer registers how it renames while it's mounted — returns the unregister. */
export function registerExplorerRename(rename: ExplorerRename): () => void {
  explorerRename = rename;
  return () => {
    if (explorerRename === rename) explorerRename = null;
  };
}

/**
 * The one way a file/folder gets renamed: through Project Explorer's tree
 * when it's showing the path (so the tree re-lists), on disk directly
 * otherwise — then open tabs (`pathRenamed` from `useOpenFiles`) and the
 * selection follow it. Refuses to replace an existing entry (a plain
 * `rename` would silently overwrite a file). Throws on failure.
 */
export async function renamePath(path: string, newName: string, pathRenamed: (from: string, to: string) => void): Promise<void> {
  const to = renamedPath(path, newName);
  if (to === path) return;
  // A case-only rename names the same entry on a case-insensitive disk.
  if (to.toLowerCase() !== path.toLowerCase()) {
    const taken = await files.info(to).then(
      () => true,
      () => false
    );
    if (taken) throw new Error(t('"{name}" already exists.', { name: newName }));
  }
  const handled = explorerRename ? await explorerRename(path, newName) : false;
  if (!handled) await files.rename(path, to);
  pathRenamed(path, to);
  selectionPathRenamed(path, to);
}
