import { useEffect, useRef, useState, type FocusEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import {
  FileTree,
  confirmDialog,
  promptDialog,
  useDirectoryTree,
  t,
  useT,
  type DirEntry,
  type FileTreeMenuItem,
  type FileTreeNode,
} from "substrate-platform-ui";
import { useProject, type ProjectInfo } from "../ProjectContext";
import { openWithItems, useOpenFiles } from "../OpenFilesContext";
import { openFile } from "../fileOpenBus";
import { reportError } from "../reportError";
import { IDE_OUTPUT_EVENT } from "../outputSource";
import { isWithin, renamedPath, validateEntryName as validateName } from "../paths";
import { registerExplorerRename, renamePath, selectionPathRemoved, selectMultiple, selectPath } from "../ideSelection";

const dirCommands = {
  list: (path: string) => invoke<DirEntry[]>("dir_list", { path }),
  createFile: (path: string) => invoke<void>("dir_create_file", { path }),
  createDir: (path: string) => invoke<void>("dir_create_dir", { path }),
  rename: (from: string, to: string) => invoke<void>("dir_rename", { from, to }),
  remove: (path: string) => invoke<void>("dir_remove", { path }),
};

/** A folder that failed to list stays unloaded in the tree (expanding it again retries) — say why in Output rather than only the devtools console. */
function reportListError(error: unknown, path: string) {
  emit(IDE_OUTPUT_EVENT, `[error] failed to list ${path}: ${error}`);
}

export function ProjectExplorer() {
  const t = useT();
  const { project, error } = useProject();

  if (!project) {
    return (
      <div style={{ padding: "var(--sp-space-sm)", color: "var(--sp-text-muted)" }}>
        {error ? t("Failed to open project: {error}", { error }) : t("No project open — use File > Open Project or Open Folder.")}
      </div>
    );
  }
  return <ProjectExplorerTree key={project.root} project={project} />;
}

/** Runs a tree operation, reporting a failure instead of letting it vanish into an unhandled rejection. */
async function attempt(what: string, op: () => Promise<void>) {
  try {
    await op();
  } catch (err) {
    reportError(`${what}: ${err}`);
  }
}

function ProjectExplorerTree({ project }: { project: ProjectInfo }) {
  // Expanded folders are remembered per project (see `WorkspaceProvider`).
  useT();
  const tree = useDirectoryTree(project.root, project.name, dirCommands, reportListError, "explorer.expanded");
  const { tabs, pathRenamed, pathRemoved } = useOpenFiles();
  // Controlled, so a rename (here or from Properties) can carry the
  // selection over to the new path instead of losing it.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const treeRef = useRef(tree);
  treeRef.current = tree;

  // Properties' "File Name" renames through here while the path is in the
  // tree, so the tree re-lists its folder.
  useEffect(
    () =>
      registerExplorerRename(async (path, newName) => {
        const node = findNode(treeRef.current.nodes, path);
        if (!node) return false;
        await treeRef.current.renameNode(node, newName);
        const to = renamedPath(path, newName);
        setSelectedIds((prev) => new Set([...prev].map((id) => (isWithin(id, path) ? to + id.slice(path.length) : id))));
        return true;
      }),
    []
  );

  /** Makes this tree's selection the global one (what Properties shows). */
  function publishSelection(ids: Set<string>) {
    if (ids.size > 1) return selectMultiple(ids.size, "explorer");
    const [id] = ids;
    if (id === undefined) return;
    const node = findNode(tree.nodes, id);
    selectPath(id, node?.kind ?? "file", "explorer");
  }

  /** Coming back to the tree from elsewhere (an editor) makes its selection current again, as in Visual Studio. */
  function handleFocus(e: FocusEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) publishSelection(selectedIds);
  }

  function getMenuItems(node: FileTreeNode): FileTreeMenuItem[] {
    const items: FileTreeMenuItem[] = [];
    if (node.kind === "file") {
      items.push({ label: t("Open"), onSelect: (n) => openFile({ path: n.id, name: n.name }) });
      const current = tabs.find((t) => t.path === node.id)?.view;
      items.push({
        label: t("Open With"),
        submenu: openWithItems(node.id, current, (view) => openFile({ path: node.id, name: node.name, view })),
      });
    }
    if (node.kind === "folder") {
      items.push({
        label: t("New File..."),
        onSelect: async (n) => {
          const name = await promptDialog({ title: t("New File"), label: t("File name"), confirmLabel: t("Create"), validate: validateName });
          if (name === null) return;
          await attempt(t("Failed to create {name}", { name: name.trim() }), async () => {
            await tree.createFileIn(n.id, name.trim());
            openFile({ path: `${n.id.replace(/[/\\]+$/, "")}/${name.trim()}` });
          });
        },
      });
      items.push({
        label: t("New Folder..."),
        onSelect: async (n) => {
          const name = await promptDialog({ title: t("New Folder"), label: t("Folder name"), confirmLabel: t("Create"), validate: validateName });
          if (name === null) return;
          await attempt(t("Failed to create {name}", { name: name.trim() }), () => tree.createDirIn(n.id, name.trim()));
        },
      });
    }
    if (node.id !== project.root) {
      items.push({
        label: t("Rename"),
        separatorBefore: items.length > 0,
        onSelect: async (n) => {
          const name = await promptDialog({ title: t("Rename"), label: t("New name"), defaultValue: n.name, confirmLabel: t("Rename"), validate: validateName });
          if (name === null || name.trim() === n.name) return;
          // Open tabs and the selection under the old path follow it to the new one.
          await attempt(t("Failed to rename {name}", { name: n.name }), () => renamePath(n.id, name.trim(), pathRenamed));
        },
      });
      items.push({
        label: t("Delete"),
        destructive: true,
        onSelect: async (n) => {
          const confirmed = await confirmDialog({
            title: n.kind === "folder" ? t("Delete Folder") : t("Delete File"),
            message: n.kind === "folder" ? t('Delete "{name}" and everything in it?', { name: n.name }) : t('Delete "{name}"?', { name: n.name }),
            confirmLabel: t("Delete"),
          });
          if (!confirmed) return;
          await attempt(t("Failed to delete {name}", { name: n.name }), async () => {
            await tree.removeNode(n);
            pathRemoved(n.id);
            selectionPathRemoved(n.id);
            setSelectedIds((prev) => new Set([...prev].filter((id) => !isWithin(id, n.id))));
          });
        },
      });
    }
    return items;
  }

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "var(--sp-space-xs)", boxSizing: "border-box" }} onFocus={handleFocus}>
      <FileTree
        nodes={tree.nodes}
        expandedIds={tree.expandedIds}
        onExpandedChange={tree.onExpandedChange}
        selectedIds={selectedIds}
        onSelectionChange={(ids) => {
          setSelectedIds(ids);
          publishSelection(ids);
        }}
        onActivate={(node) => openFile({ path: node.id, name: node.name })}
        getMenuItems={getMenuItems}
      />
    </div>
  );
}

function findNode(nodes: FileTreeNode[], id: string): FileTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const inner = node.children ? findNode(node.children, id) : null;
    if (inner) return inner;
  }
  return null;
}
