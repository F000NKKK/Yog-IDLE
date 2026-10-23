import type { ReactNode } from "react";
import { Icon, fileNameOf, joinPath, textMatchRanges, type FileTreeMatch, type FileTreeNode } from "substrate-platform-ui";
import { generatedCodePath, isWithin, parentOf } from "../../project/paths";

// What Project Explorer shows of a Yog project, as pure transforms over the
// tree: Visual Studio's file nesting, generated code under its source, the
// Resources folder's icon, Show All Files, version-control marks, the row of
// an item being named — and what its search box and filters match.

/**
 * Visual Studio's file nesting (`Form1.cs` ▸ `Form1.Designer.cs`, `Form1.resx`):
 * a screen's code-behind `foo.rs` goes under `foo.yui`, and a lock file under
 * its manifest.
 */
export function nestParent(name: string, siblings: Set<string>): string | null {
  const lower = name.toLowerCase();
  const code = /^(.*)\.rs$/.exec(lower);
  if (code && siblings.has(`${code[1]}.yui`)) return `${code[1]}.yui`;
  // A resource set's culture variants under its neutral file: `Strings.ru_ru.yres` ▸ under `Strings.yres`.
  const culture = /^(.*)\.[a-z]{2,3}_[a-z0-9]{2,4}\.yres$/.exec(lower);
  if (culture && siblings.has(`${culture[1]}.yres`)) return `${culture[1]}.yres`;
  if (lower === "yog.lock") return "yog.toml";
  if (lower === "cargo.lock") return "cargo.toml";
  return null;
}

/** `fn` applied to every node — folders' children and files' nested ones included — rebuilding only what changed. */
export function mapNodes(nodes: FileTreeNode[], fn: (node: FileTreeNode) => FileTreeNode): FileTreeNode[] {
  let changed = false;
  const out = nodes.map((node) => {
    const children = node.children && mapNodes(node.children, fn);
    const nested = node.nested && mapNodes(node.nested, fn);
    const inner = children === node.children && nested === node.nested ? node : { ...node, children, nested };
    const next = fn(inner);
    if (next !== node) changed = true;
    return next;
  });
  return changed ? out : nodes;
}

/**
 * Adds each screen's generated code (`obj/generated/<path>.g.rs`, not
 * in the tree's folders) under its `.yui`, and each resource set's
 * (`obj/generated/resources/<Set>.g.rs`) under its neutral `.yres`,
 * greyed, when the build has made it — like Visual Studio showing `MainWindow.g.cs` under a XAML window
 * and `Resources.Designer.cs` under a `.resx`. Opens read-only.
 */
export function withGeneratedCode(nodes: FileTreeNode[], root: string, exists: ReadonlySet<string>): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.kind === "folder") return node.children ? { ...node, children: withGeneratedCode(node.children, root, exists) } : node;
    const generated = generatedCodePath(root, node.id);
    // Only code the build made: a component's goes to components.g.rs, a
    // screen not built yet has none.
    if (!generated || !exists.has(generated)) return node;
    const child: FileTreeNode = { id: generated, name: fileNameOf(generated), kind: "file", generated: true };
    return { ...node, nested: [...(node.nested ?? []), child] };
  });
}

/** The mod's `resources/` folder gets its own icon, like a C# project's Resources (files have their kind's — `fileTypes`). */
export function withResourceIcons(nodes: FileTreeNode[], resourcesDir: string): FileTreeNode[] {
  const target = resourcesDir.replace(/\\/g, "/");
  return mapNodes(nodes, (node) =>
    node.kind === "folder" && node.id.replace(/\\/g, "/") === target ? { ...node, icon: <Icon name="folderTable" size={15} /> } : node
  );
}

/**
 * Show All Files: what isn't part of the project (`items` — build output,
 * git-ignored files, VCS metadata) is hidden, or with `showAll` shown
 * dimmed, as Visual Studio shows files outside the project. Unknown yet
 * (`items` null): everything shows as is. Runs on the listed folders, before
 * nesting.
 */
export function withProjectItems(nodes: FileTreeNode[], root: string, items: ReadonlySet<string> | null, showAll: boolean): FileTreeNode[] {
  if (!items) return nodes;
  const inProject = (node: FileTreeNode) => node.id === root || node.generated || items.has(node.id);
  const walk = (list: FileTreeNode[]): FileTreeNode[] =>
    list.flatMap((node) => {
      const own = inProject(node);
      if (!own && !showAll) return [];
      const children = node.children && walk(node.children);
      return [{ ...node, children, faded: node.faded || !own }];
    });
  return walk(nodes);
}

/**
 * Marks each changed file with what `mark` gives for it (its version-control
 * status letter), and each folder holding a change with `folderMark`.
 */
export function withChangeMarks(
  nodes: FileTreeNode[],
  changed: ReadonlyMap<string, string>,
  mark: (kind: string) => ReactNode,
  folderMark: ReactNode
): FileTreeNode[] {
  if (changed.size === 0) return nodes;
  const folders = new Set<string>();
  for (const path of changed.keys()) {
    for (let dir = parentOf(path); dir && dir !== path && !folders.has(dir); dir = parentOf(dir)) folders.add(dir);
  }
  return mapNodes(nodes, (node) => {
    const kind = node.kind === "file" ? changed.get(node.id) : undefined;
    if (kind) return { ...node, decoration: mark(kind) };
    if (node.kind === "folder" && folders.has(node.id)) return { ...node, decoration: folderMark };
    return node;
  });
}

/** Cut and waiting for a Paste: drawn dimmed, as in Explorer. */
export function withFaded(nodes: FileTreeNode[], paths: readonly string[]): FileTreeNode[] {
  if (paths.length === 0) return nodes;
  return mapNodes(nodes, (node) => (paths.some((p) => isWithin(node.id, p)) && !node.faded ? { ...node, faded: true } : node));
}

/** The id of the row a new item is named in, inside `folder`. */
export function placeholderId(folder: string): string {
  return joinPath(folder, "\u0000new");
}

/**
 * New File / New Folder name the item in place, as in Visual Studio: an
 * empty row in `folder` — a folder's at the top, a file's after the last
 * folder — that the tree edits inline.
 */
export function withPlaceholder(nodes: FileTreeNode[], folder: string, kind: FileTreeNode["kind"]): FileTreeNode[] {
  const row: FileTreeNode = { id: placeholderId(folder), name: "", kind, children: kind === "folder" ? [] : undefined };
  return mapNodes(nodes, (node) => {
    if (node.id !== folder || node.kind !== "folder") return node;
    const children = node.children ?? [];
    const at = kind === "folder" ? 0 : children.filter((c) => c.kind === "folder").length;
    return { ...node, children: [...children.slice(0, at), row, ...children.slice(at)] };
  });
}

export function findNode(nodes: FileTreeNode[], id: string): FileTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const inner = (node.children && findNode(node.children, id)) || (node.nested && findNode(node.nested, id));
    if (inner) return inner;
  }
  return null;
}

/** The rows that have to be open to show `id` — its folders and, for a nested file, the file it's under — top down; `null` when it isn't in `nodes`. */
export function pathTo(nodes: FileTreeNode[], id: string): string[] | null {
  for (const node of nodes) {
    if (node.id === id) return [];
    for (const inner of [node.children, node.nested]) {
      const rest = inner && pathTo(inner, id);
      if (rest) return [node.id, ...rest];
    }
  }
  return null;
}

/** What the search box and the filters narrow the tree to. */
export interface ExplorerFilter {
  /** The search box's text. */
  query: string;
  /** Files whose contents match `query` ("Search within file contents"), when that's on. */
  contentHits: ReadonlySet<string> | null;
  /** Open Files / Pending Changes: only these files. */
  only: ReadonlySet<string> | null;
}

/**
 * Solution Explorer's search: a name containing the text (marked), or a
 * file whose contents do; the Open Files / Pending Changes filters keep
 * only their files. Folders are kept for what's in them (`filterFileTree`).
 */
export function explorerMatch({ query, contentHits, only }: ExplorerFilter): FileTreeMatch {
  const searching = query.trim() !== "";
  return (node) => {
    if (only && (node.kind !== "file" || !only.has(node.id))) return false;
    if (!searching) return !!only;
    return textMatchRanges(node.name, query) ?? !!contentHits?.has(node.id);
  };
}
