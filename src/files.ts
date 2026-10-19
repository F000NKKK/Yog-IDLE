// Files as Yog IDLE reads them: the platform's (`hostFiles`), a path's
// properties, the project's items — and the one way to read a mod's id.

import { invoke } from "@tauri-apps/api/core";
import { hostFiles, type DirEntry } from "substrate-platform-ui";

/** `path_info`'s answer (see `properties.rs`). */
export interface PathInfo {
  kind: "file" | "dir";
  size: number;
  modified: number | null;
  created: number | null;
  readOnly: boolean;
  itemCount: number | null;
  isModProject: boolean;
}

export const files = {
  ...hostFiles,
  info: (path: string) => invoke<PathInfo>("path_info", { path }),
  /** Every file and folder of the project (git-ignored ones, build output and VCS metadata left out) — `search.rs`. */
  projectItems: (root: string) => invoke<DirEntry[]>("project_items", { root }),
  /** The project's files whose text contains `pattern` (ignoring case). */
  filesContaining: (root: string, pattern: string) => invoke<string[]>("project_files_containing", { root, query: { pattern } }),
};

/** The `[mod] id` of the project at `root` — `null` without a readable `yog.toml`. */
export function readModId(root: string): Promise<string | null> {
  return invoke<{ fields: { id?: string } }>("mod_manifest_read", { projectRoot: root }).then(
    (m) => m.fields.id ?? null,
    () => null,
  );
}
