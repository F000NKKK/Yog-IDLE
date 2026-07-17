import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileTree, useDirectoryTree, type DirEntry, type FileTreeMenuItem } from "substrate-platform-ui";
import { DEV_SOLUTION_PATH } from "../devSolution";

interface ProjectInfo {
  name: string;
  root: string;
  kind: string | null;
}

const dirCommands = {
  list: (path: string) => invoke<DirEntry[]>("dir_list", { path }),
  createFile: (path: string) => invoke<void>("dir_create_file", { path }),
  createDir: (path: string) => invoke<void>("dir_create_dir", { path }),
  rename: (from: string, to: string) => invoke<void>("dir_rename", { from, to }),
  remove: (path: string) => invoke<void>("dir_remove", { path }),
};

export function SolutionExplorer() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<{ name: string; projects: ProjectInfo[] }>("solution_open", { path: DEV_SOLUTION_PATH })
      .then((solution) => setProject(solution.projects[0] ?? null))
      .catch((err) => setError(String(err)));
  }, []);

  if (!project) {
    return (
      <div style={{ padding: "var(--sp-space-sm)", color: "var(--sp-text-muted)" }}>
        {error ? `Failed to open solution: ${error}` : "Opening solution…"}
      </div>
    );
  }
  return <ProjectExplorer project={project} />;
}

function ProjectExplorer({ project }: { project: ProjectInfo }) {
  const tree = useDirectoryTree(project.root, project.name, dirCommands);

  function getMenuItems(node: { id: string; name: string; kind: "file" | "folder" }): FileTreeMenuItem[] {
    const items: FileTreeMenuItem[] = [];
    if (node.kind === "folder") {
      items.push({
        label: "New File...",
        onSelect: (n) => {
          const name = window.prompt("File name:");
          if (name) tree.createFileIn(n.id, name);
        },
      });
      items.push({
        label: "New Folder...",
        onSelect: (n) => {
          const name = window.prompt("Folder name:");
          if (name) tree.createDirIn(n.id, name);
        },
      });
    }
    if (node.id !== project.root) {
      items.push({
        label: "Rename",
        onSelect: (n) => {
          const name = window.prompt("New name:", n.name);
          if (name && name !== n.name) tree.renameNode(n, name);
        },
      });
      items.push({
        label: "Delete",
        destructive: true,
        onSelect: (n) => {
          if (window.confirm(`Delete "${n.name}"?`)) tree.removeNode(n);
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
        getMenuItems={getMenuItems}
      />
    </div>
  );
}
