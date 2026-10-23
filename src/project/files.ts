// Files as Yog IDLE reads them: the platform's (`hostFiles`), a path's
// properties, the project's items — and the one way to read a mod's id.
// A Yog format's file is binary Yog Data on disk: it's read as its text
// and written from text through the CLI (`source.read` / `source.write`).

import { type DirEntry, hostFiles, invokeCommand, substrate } from "substrate-platform-ui";
import { cli } from "../toolchain/cli";
import { formats, serveMethod } from "../data/yogIds.generated";
import { yog } from "../host.generated";

/** The extensions of the formats whose files are Yog Data. */
const DATA_EXTS = new Set<string>(Object.values(formats).filter((f) => f.isData).map((f) => f.ext));

/** Whether the file at `path` is a Yog format's (binary on disk, text in the editor). */
export function isDataFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && DATA_EXTS.has(path.slice(dot + 1));
}

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
  read: (path: string): Promise<string> => (isDataFile(path) ? cli<string>(serveMethod.SOURCE_READ, { path }) : hostFiles.read(path)),
  /** Writes `contents`; a Yog format's file binary — rejects with `{ message, line, col }` if its text doesn't parse. */
  write: (path: string, contents: string): Promise<void> =>
    isDataFile(path) ? cli<null>(serveMethod.SOURCE_WRITE, { path, text: contents }).then(() => undefined) : hostFiles.write(path, contents),
  info: (path: string) => invokeCommand<PathInfo>(yog.project.pathInfo, { path }),
  /** Every file and folder of the project (git-ignored ones, build output and VCS metadata left out) — `search.rs`. */
  projectItems: (root: string) => invokeCommand<DirEntry[]>(substrate.search.projectItems, { root }),
  /** The project's files whose text contains `pattern` (ignoring case). */
  filesContaining: (root: string, pattern: string) => invokeCommand<string[]>(substrate.search.projectFilesContaining, { root, query: { pattern } }),
};

/** The `[mod] id` of the project at `root` — `null` without a readable `yog.toml`. */
export function readModId(root: string): Promise<string | null> {
  return invokeCommand<{ fields: { id?: string } }>(yog.project.modManifestRead, { projectRoot: root }).then(
    (m) => m.fields.id ?? null,
    () => null,
  );
}
