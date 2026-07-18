import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DEV_SOLUTION_PATH } from "./devSolution";

export interface ProjectInfo {
  name: string;
  root: string;
  kind: string | null;
}

interface ProjectContextValue {
  project: ProjectInfo | null;
  error: string | null;
  /** Opens a folder as the current project — used by both the initial dev default and the File menu's Open Folder/Open Project. Yog-IDLE has no "solution" grouping concept, just a single project identified by `yog.toml`. */
  openPath: (path: string) => Promise<void>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

/**
 * The single source of truth for "what project is currently open" — replaces
 * every panel independently calling `project_open` with the same hardcoded
 * dev path. Solution Explorer, the Build menu, and the Run toolbar all read
 * from here, and the File menu's Open Folder/Open Project write to it.
 */
export function ProjectProvider({ children }: { children: ReactNode }) {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function openPath(path: string) {
    try {
      const opened = await invoke<ProjectInfo>("project_open", { path });
      setProject(opened);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    openPath(DEV_SOLUTION_PATH);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <ProjectContext.Provider value={{ project, error, openPath }}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProject must be used within a ProjectProvider");
  return ctx;
}
