// Files as Yog IDLE reads them: the platform's (`hostFiles`), a path's
// properties, the project's items — and the one way to read a mod's id.

import { type DirEntry, hostFiles, invokeCommand } from "substrate-platform-ui";
import { yog } from "./plugins.generated";

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
  info: (path: string) => invokeCommand<PathInfo>(yog.project.pathInfo, { path }),
  /** Every file and folder of the project (git-ignored ones, build output and VCS metadata left out) — `search.rs`. */
  projectItems: (root: string) => invokeCommand<DirEntry[]>(yog.code.projectItems, { root }),
  /** The project's files whose text contains `pattern` (ignoring case). */
  filesContaining: (root: string, pattern: string) => invokeCommand<string[]>(yog.code.projectFilesContaining, { root, query: { pattern } }),
};

/** The `[mod] id` of the project at `root` — `null` without a readable `yog.toml`. */
export function readModId(root: string): Promise<string | null> {
  return invokeCommand<{ fields: { id?: string } }>(yog.project.modManifestRead, { projectRoot: root }).then(
    (m) => m.fields.id ?? null,
    () => null,
  );
}
