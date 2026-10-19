import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { yog } from "./host.generated";
import { invokeCommand } from "substrate-platform-ui";

export interface ProjectInfo {
  name: string;
  root: string;
  kind: string | null;
}

/** How something was opened — Open Project and Open Folder keep separate recent lists. */
export type OpenKind = "project" | "folder";

export interface RecentEntry {
  root: string;
  /** Shown in the menu instead of the path: the project's name for projects, the folder's name for folders. */
  name: string;
}

interface ProjectContextValue {
  project: ProjectInfo | null;
  error: string | null;
  /** Opens a folder as the current project — used by the File menu's Open Folder/Open Project/recent entries and the startup reopen. Yog-IDLE has no "solution" grouping concept, just a single project identified by `yog.toml`. `kind` picks which recent list it goes to. */
  openPath: (path: string, kind: OpenKind) => Promise<void>;
  /** Recently opened entries per kind, most recent first. */
  recent: Record<OpenKind, RecentEntry[]>;
  clearRecent: (kind: OpenKind) => void;
  /** File > Close Folder: back to no project, and none reopened on the next start. Unsaved tabs are the caller's to settle first. */
  closeProject: () => void;
}

const RECENT_KEYS: Record<OpenKind, string> = {
  project: "yog-idle.recentProjects",
  folder: "yog-idle.recentFolders",
};
/** Whatever was opened last, of either kind — reopened on startup. */
const LAST_KEY = "yog-idle.lastOpened";
const MAX_RECENT = 8;

function baseName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

function loadRecent(kind: OpenKind): RecentEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEYS[kind]) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((e): RecentEntry[] => {
      if (e && typeof e.root === "string" && typeof e.name === "string") return [{ root: e.root, name: e.name }];
      return [];
    });
  } catch {
    return [];
  }
}

function loadLast(): { root: string; kind: OpenKind } | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null");
    if (parsed && typeof parsed === "object" && "root" in parsed && "kind" in parsed) {
      const { root, kind } = parsed as { root: unknown; kind: unknown };
      if (typeof root === "string" && (kind === "project" || kind === "folder")) return { root, kind };
    }
  } catch {
    // fall through
  }
  return null;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

/**
 * The single source of truth for "what project is currently open" — Project
 * Explorer, the Build menu, and the Run toolbar all read from here, and the
 * File menu writes to it. Every successfully opened project/folder goes
 * to the front of its own small recent list (persisted in `localStorage`);
 * on startup whatever was opened last is reopened, if it still exists.
 */
export function ProjectProvider({ children }: { children: ReactNode }) {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<Record<OpenKind, RecentEntry[]>>(() => ({
    project: loadRecent("project"),
    folder: loadRecent("folder"),
  }));

  function updateRecent(kind: OpenKind, update: (prev: RecentEntry[]) => RecentEntry[]) {
    setRecent((prev) => {
      const next = update(prev[kind]);
      localStorage.setItem(RECENT_KEYS[kind], JSON.stringify(next));
      return { ...prev, [kind]: next };
    });
  }

  async function openPath(path: string, kind: OpenKind) {
    try {
      const opened = await invokeCommand<ProjectInfo>(yog.project.projectOpen, { path });
      setProject(opened);
      setError(null);
      const entry: RecentEntry = { root: opened.root, name: kind === "project" ? opened.name : baseName(opened.root) };
      updateRecent(kind, (prev) => [entry, ...prev.filter((e) => e.root !== opened.root && e.root !== path)].slice(0, MAX_RECENT));
      localStorage.setItem(LAST_KEY, JSON.stringify({ root: opened.root, kind }));
    } catch (err) {
      setError(String(err));
      // Moved or deleted since — no point offering it again.
      updateRecent(kind, (prev) => prev.filter((e) => e.root !== path));
    }
  }

  function closeProject() {
    setProject(null);
    setError(null);
    localStorage.removeItem(LAST_KEY);
  }

  useEffect(() => {
    const last = loadLast();
    if (last) openPath(last.root, last.kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ProjectContext.Provider value={{ project, error, openPath, recent, clearRecent: (kind) => updateRecent(kind, () => []), closeProject }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProject must be used within a ProjectProvider");
  return ctx;
}
