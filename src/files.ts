// The backend's file-system commands (`src-tauri/src/lib.rs`), typed — and
// the one way to read a mod's id.

import { invoke } from "@tauri-apps/api/core";
import type { DirEntry } from "substrate-platform-ui";

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
  read: (path: string) => invoke<string>("file_read", { path }),
  write: (path: string, contents: string) => invoke<void>("file_write", { path, contents }),
  info: (path: string) => invoke<PathInfo>("path_info", { path }),
  list: (path: string) => invoke<DirEntry[]>("dir_list", { path }),
  createFile: (path: string) => invoke<void>("dir_create_file", { path }),
  createDir: (path: string) => invoke<void>("dir_create_dir", { path }),
  rename: (from: string, to: string) => invoke<void>("dir_rename", { from, to }),
  copy: (from: string, to: string) => invoke<void>("dir_copy", { from, to }),
  remove: (path: string) => invoke<void>("dir_remove", { path }),
};

/** The `[mod] id` of the project at `root` — `null` without a readable `yog.toml`. */
export function readModId(root: string): Promise<string | null> {
  return invoke<{ fields: { id?: string } }>("mod_manifest_read", { projectRoot: root }).then(
    (m) => m.fields.id ?? null,
    () => null,
  );
}
