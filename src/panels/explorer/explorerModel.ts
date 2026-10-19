// Project Explorer's helpers: guarded file operations, copy names, the mod's
// id, code-behind pairs, generated code, changed files, what's being typed.

import { useEffect, useMemo, useState } from "react";
import { type ChangeKind, type FileTreeNode, reportError, type RepoStatus, t } from "substrate-platform-ui";
import type { ProjectInfo } from "../../ProjectContext";
import { files, readModId } from "../../files";
import { useFsChanged } from "../../fsWatch";
import { generatedCodePath } from "../../paths";

export async function attempt(what: string, op: () => Promise<void>) {
  try {
    await op();
  } catch (err) {
    reportError(`${what}: ${err}`);
  }
}

/** Cut or Copy in the explorer, waiting for a Paste — module-level so it survives the tree remounting, and shared by every view. */
export let explorerClipboard: { paths: string[]; cut: boolean } | null = null;

/** Puts paths on Project Explorer's clipboard (Copy, Cut), or empties it. */
export function setExplorerClipboard(next: { paths: string[]; cut: boolean } | null): void {
  explorerClipboard = next;
}

/** Windows Explorer's / Visual Studio's name for a pasted duplicate: `a - Copy.rs`, `a - Copy (2).rs`. */
export function copyName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; ; n++) {
    const candidate = `${stem}${t(" - Copy")}${n > 1 ? ` (${n})` : ""}${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** The mod's id from `yog.toml` — new UI screens are named under it. */
export async function modIdOf(project: ProjectInfo): Promise<string> {
  const id = await readModId(project.root);
  if (id) return id;
  return project.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
}

/** For `foo.yui` its code-behind `foo.rs`, and the other way round — F7 / Shift+F7 in Visual Studio. */
export function codeBehindPair(path: string): { screen: string; code: string } | null {
  const m = /^(.*)\.(yui|rs)$/i.exec(path);
  if (!m || /\.designer$/i.test(m[1])) return null;
  return { screen: `${m[1]}.yui`, code: `${m[1]}.rs` };
}

export const copyText = (text: string) =>
  navigator.clipboard.writeText(text).catch((err) => reportError(t("Couldn't copy to the clipboard: {error}", { error: String(err) })));

/** The generated files (`generatedCodePath`) of the tree's screens and resource sets that exist — re-checked as files change and when the window comes back. */
export function useGeneratedCode(project: ProjectInfo, nodes: FileTreeNode[]): ReadonlySet<string> {
  const [exists, setExists] = useState<ReadonlySet<string>>(new Set());
  const [checks, setChecks] = useState(0);
  const candidates = useMemo(() => {
    if (project.kind !== "yog-mod") return [];
    const out: string[] = [];
    const walk = (list: FileTreeNode[]) => {
      for (const n of list) {
        if (n.kind === "folder") walk(n.children ?? []);
        else {
          const g = generatedCodePath(project.root, n.id);
          if (g) out.push(g);
        }
      }
    };
    walk(nodes);
    return out;
  }, [project.kind, project.root, nodes]);
  const key = candidates.join("\n");
  useEffect(() => {
    let live = true;
    void Promise.all(candidates.map((p) => files.info(p).then((i) => (i.kind === "file" ? p : null), () => null))).then((found) => {
      if (!live) return;
      const next = new Set(found.filter((p): p is string => !!p));
      setExists((cur) => (cur.size === next.size && [...next].every((p) => cur.has(p)) ? cur : next));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, checks]);
  useFsChanged(() => setChecks((n) => n + 1));
  useEffect(() => {
    const again = () => setChecks((n) => n + 1);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);
  return exists;
}

/** Each changed file's status in the working tree, the worst of its staged and unstaged changes (deleted files aren't in the tree). */
export function changedFiles(status: RepoStatus | null): Map<string, ChangeKind> {
  const out = new Map<string, ChangeKind>();
  if (!status) return out;
  for (const change of [...status.staged, ...status.unstaged, ...status.conflicted]) {
    if (change.kind !== "deleted") out.set(change.absPath, change.kind);
  }
  return out;
}

/** Open Files and Pending Changes, Solution Explorer's two filters. */
export type ListFilter = "filterOpenFiles" | "filterPendingChanges";

/** What's being typed into a row: a rename, or a new item's name. */
export type Editing = { kind: "rename"; id: string } | { kind: "new"; folder: string; isFolder: boolean };

/** Scope to This: the folder the tree is rooted at, with Back/Forward history. */
export interface ScopeHistory {
  stack: string[];
  at: number;
}

/** Every folder (and file with nested ones) at or under `node`. */
export function folderIdsUnder(node: FileTreeNode, out: string[] = []): string[] {
  const inner = node.children ?? node.nested;
  if (!inner) return out;
  out.push(node.id);
  for (const child of inner) folderIdsUnder(child, out);
  return out;
}
