import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import {
  FileTree,
  confirmDialog,
  promptDialog,
  useDirectoryTree,
  type DirEntry,
  type FileTreeMenuItem,
  type FileTreeNode,
} from "substrate-platform-ui";
import { useProject, type ProjectInfo } from "../ProjectContext";
import { useOpenFiles } from "../OpenFilesContext";
import { openFile } from "../fileOpenBus";
import { reportError } from "../reportError";
import { IDE_OUTPUT_EVENT } from "../outputSource";

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
  const { project, error } = useProject();

  if (!project) {
    return (
      <div style={{ padding: "var(--sp-space-sm)", color: "var(--sp-text-muted)" }}>
        {error ? `Failed to open project: ${error}` : "No project open — use File > Open Project or Open Folder."}
      </div>
    );
  }
  return <ProjectExplorerTree project={project} />;
}

/** A name for a new/renamed entry: non-empty, and a single path segment. */
function validateName(value: string): string | null {
  const name = value.trim();
  if (!name) return "";
  if (/[/\\]/.test(name)) return "A name can't contain / or \\.";
  if (name === "." || name === "..") return "Not a valid name.";
  return null;
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
  const tree = useDirectoryTree(project.root, project.name, dirCommands, reportListError, "explorer.expanded");
  const { pathRenamed, pathRemoved } = useOpenFiles();

  function getMenuItems(node: FileTreeNode): FileTreeMenuItem[] {
    const items: FileTreeMenuItem[] = [];
    if (node.kind === "folder") {
      items.push({
        label: "New File...",
        onSelect: async (n) => {
          const name = await promptDialog({ title: "New File", label: "File name", confirmLabel: "Create", validate: validateName });
          if (name === null) return;
          await attempt(`Failed to create ${name.trim()}`, async () => {
            await tree.createFileIn(n.id, name.trim());
            openFile({ path: `${n.id.replace(/[/\\]+$/, "")}/${name.trim()}` });
          });
        },
      });
      items.push({
        label: "New Folder...",
        onSelect: async (n) => {
          const name = await promptDialog({ title: "New Folder", label: "Folder name", confirmLabel: "Create", validate: validateName });
          if (name === null) return;
          await attempt(`Failed to create ${name.trim()}`, () => tree.createDirIn(n.id, name.trim()));
        },
      });
    }
    if (node.id !== project.root) {
      items.push({
        label: "Rename",
        onSelect: async (n) => {
          const name = await promptDialog({ title: "Rename", label: "New name", defaultValue: n.name, confirmLabel: "Rename", validate: validateName });
          if (name === null || name.trim() === n.name) return;
          await attempt(`Failed to rename ${n.name}`, async () => {
            await tree.renameNode(n, name.trim());
            // Open tabs under the old path follow it to the new one.
            pathRenamed(n.id, n.id.replace(/[^/\\]+$/, name.trim()));
          });
        },
      });
      items.push({
        label: "Delete",
        destructive: true,
        onSelect: async (n) => {
          const confirmed = await confirmDialog({
            title: n.kind === "folder" ? "Delete Folder" : "Delete File",
            message: n.kind === "folder" ? `Delete "${n.name}" and everything in it?` : `Delete "${n.name}"?`,
            confirmLabel: "Delete",
          });
          if (!confirmed) return;
          await attempt(`Failed to delete ${n.name}`, async () => {
            await tree.removeNode(n);
            pathRemoved(n.id);
          });
        },
      });
    }
    return items;
  }

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "var(--sp-space-xs)", boxSizing: "border-box" }}>
      <FileTree
        nodes={tree.nodes}
        expandedIds={tree.expandedIds}
        onExpandedChange={tree.onExpandedChange}
        onActivate={(node) => openFile({ path: node.id, name: node.name })}
        getMenuItems={getMenuItems}
      />
    </div>
  );
}
