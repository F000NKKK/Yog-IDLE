import { invoke } from "@tauri-apps/api/core";
import { t } from "substrate-platform-ui";

/** `project_properties::Dependency` — one `[dependencies]` / `[dependencies.exports]` entry. */
export interface Dependency {
  name: string;
  version: string;
  features: string[];
  defaultFeatures: boolean;
  optional: boolean;
  path: string;
  git: string;
  /** Keys of an inline-table spec the form doesn't edit (kept as written). */
  otherKeys: string[];
}

export interface ProjectProps {
  manifest: {
    fields: Record<string, string>;
    authors: string[];
    yogApiPath: string | null;
  };
  yogApiVersion: string | null;
  dependencies: Dependency[];
  modDependencies: Dependency[];
  buildTargets: string[];
}

export interface CrateHit {
  /** What goes into yog.toml — the mod id for a mod's exports crate. */
  name: string;
  crateName: string;
  version: string;
  description: string;
  downloads: number;
}

/** The backend's (English) validation messages, in the active language. */
export function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return t(text);
}

/** Every write re-reads yog.toml and returns the result — the window just shows what comes back. */
export const projectApi = {
  read: (projectRoot: string) => invoke<ProjectProps>("project_properties_read", { projectRoot }),
  setField: (projectRoot: string, key: string, value: string | string[]) => invoke<ProjectProps>("project_properties_set_field", { projectRoot, key, value }),
  setYogApi: (projectRoot: string, which: "version" | "path", value: string) => invoke<ProjectProps>("project_properties_set_yog_api", { projectRoot, which, value }),
  setDependency: (projectRoot: string, mods: boolean, original: string | null, dependency: Dependency) =>
    invoke<ProjectProps>("project_dependency_set", { projectRoot, mods, original, dependency }),
  removeDependency: (projectRoot: string, mods: boolean, name: string) => invoke<ProjectProps>("project_dependency_remove", { projectRoot, mods, name }),
  setBuildTargets: (projectRoot: string, targets: string[]) => invoke<ProjectProps>("project_build_targets_set", { projectRoot, targets }),
  searchCrates: (query: string, mods: boolean) => invoke<CrateHit[]>("crates_search", { query, mods }),
};

export function emptyDependency(name = ""): Dependency {
  return { name, version: "", features: [], defaultFeatures: true, optional: false, path: "", git: "", otherKeys: [] };
}

/** Every platform a `.yog` can bundle natives for — `environment::TARGETS`. */
export const PLATFORMS: { tag: string; label: string }[] = [
  { tag: "linux-x86_64", label: "Linux x86_64" },
  { tag: "linux-aarch64", label: "Linux ARM64" },
  { tag: "windows-x86_64", label: "Windows x86_64" },
  { tag: "macos-x86_64", label: "macOS x86_64" },
  { tag: "macos-aarch64", label: "macOS Apple Silicon" },
];
