import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface ProjectInfo {
  name: string;
  root: string;
  kind: string | null;
}

interface ProjectContextValue {
  project: ProjectInfo | null;
  error: string | null;
  /** Opens a folder as the current project — used by the File menu's Open Folder/Open Project/recent entries and the startup reopen. Yog-IDLE has no "solution" grouping concept, just a single project identified by `yog.toml`. */
  openPath: (path: string) => Promise<void>;
  /** Recently opened project roots, most recent first. */
  recent: string[];
  clearRecent: () => void;
}

const RECENT_KEY = "yog-idle.recentProjects";
const MAX_RECENT = 8;

function loadRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function saveRecent(recent: string[]) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

/**
 * The single source of truth for "what project is currently open" — Project
 * Explorer, the Build menu, and the Run toolbar all read from here, and the
 * File menu writes to it. Every successfully opened project goes to the
 * front of a small recent list (persisted in `localStorage`); on startup
 * the most recent one is reopened, if it still exists.
 */
export function ProjectProvider({ children }: { children: ReactNode }) {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(loadRecent);

  function updateRecent(update: (prev: string[]) => string[]) {
    setRecent((prev) => {
      const next = update(prev);
      saveRecent(next);
      return next;
    });
  }

  async function openPath(path: string) {
    try {
      const opened = await invoke<ProjectInfo>("project_open", { path });
      setProject(opened);
      setError(null);
      updateRecent((prev) => [opened.root, ...prev.filter((p) => p !== opened.root && p !== path)].slice(0, MAX_RECENT));
    } catch (err) {
      setError(String(err));
      // Moved or deleted since — no point offering it again.
      updateRecent((prev) => prev.filter((p) => p !== path));
    }
  }

  useEffect(() => {
    const last = loadRecent()[0];
    if (last) openPath(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ProjectContext.Provider value={{ project, error, openPath, recent, clearRecent: () => updateRecent(() => []) }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProject must be used within a ProjectProvider");
  return ctx;
}
