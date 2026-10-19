import { invokeSubstrate } from "substrate-platform-ui";

// The `git_*` commands (`src-tauri/src/git.rs`), typed. Paths in a
// `FileChange` are repo-relative and `/`-separated; `absPath` is the file on
// disk, in the same form as the paths open tabs use.

export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "copied" | "typeChanged" | "untracked" | "conflicted";

export interface FileChange {
  path: string;
  origPath: string | null;
  kind: ChangeKind;
  absPath: string;
}

export type GitOperation = "merge" | "rebase" | "cherryPick" | "revert";

export interface RepoStatus {
  repoRoot: string;
  /** `null` on a detached HEAD. */
  branch: string | null;
  /** `null` before the first commit. */
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: FileChange[];
  unstaged: FileChange[];
  conflicted: FileChange[];
  stashes: number;
  operation: GitOperation | null;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  email: string;
  /** Unix seconds. */
  date: number;
  refs: string[];
  subject: string;
}

export interface BranchInfo {
  name: string;
  remote: boolean;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  hash: string;
  date: number;
  subject: string;
}

export interface StashInfo {
  index: number;
  message: string;
  date: number;
}

/** One side of a diff: a commit, `"INDEX"`, `"WORKTREE"`, or `""` for "didn't exist". */
export interface DiffSide {
  rev: string;
  path: string;
}

export interface DiffTexts {
  left: string | null;
  right: string | null;
  binary: boolean;
}

export type RemoteOp = "fetch" | "pull" | "push" | "sync";
export type StashMode = "all" | "keepIndex" | "staged";

export interface GlobalConfig {
  version: string | null;
  values: Record<string, string>;
}

export const gitApi = {
  status: (root: string) => invokeSubstrate<RepoStatus | null>("git_status", { root }),
  stage: (root: string, paths: string[]) => invokeSubstrate<void>("git_stage", { root, paths }),
  unstage: (root: string, paths: string[]) => invokeSubstrate<void>("git_unstage", { root, paths }),
  discard: (root: string, items: { path: string; origPath: string | null; kind: ChangeKind; staged: boolean }[]) =>
    invokeSubstrate<void>("git_discard", { root, items }),
  commit: (root: string, message: string, amend: boolean, stageAll: boolean) =>
    invokeSubstrate<{ hash: string; subject: string }>("git_commit", { root, message, amend, stageAll }),
  lastMessage: (root: string) => invokeSubstrate<string>("git_last_message", { root }),
  diffTexts: (root: string, left: DiffSide, right: DiffSide) => invokeSubstrate<DiffTexts>("git_diff_texts", { root, left, right }),
  headText: (root: string, path: string) => invokeSubstrate<string | null>("git_head_text", { root, path }),
  log: (root: string, rev: string, skip: number, max: number) => invokeSubstrate<CommitInfo[]>("git_log", { root, rev, skip, max }),
  commitFiles: (root: string, hash: string) => invokeSubstrate<FileChange[]>("git_commit_files", { root, hash }),
  branches: (root: string) => invokeSubstrate<BranchInfo[]>("git_branches", { root }),
  switchTo: (root: string, name: string, remote: boolean) => invokeSubstrate<void>("git_switch", { root, name, remote }),
  createBranch: (root: string, name: string, start: string, checkout: boolean) => invokeSubstrate<void>("git_branch_create", { root, name, start, checkout }),
  deleteBranch: (root: string, name: string, force: boolean) => invokeSubstrate<void>("git_branch_delete", { root, name, force }),
  remote: (root: string, op: RemoteOp) => invokeSubstrate<void>("git_remote", { root, op }),
  integrate: (root: string, op: "merge" | "rebase", branch: string) => invokeSubstrate<void>("git_integrate", { root, op, branch }),
  operation: (root: string, goOn: boolean) => invokeSubstrate<void>("git_operation", { root, goOn }),
  clone: (url: string, parent: string, name: string) => invokeSubstrate<string>("git_clone", { url, parent, name }),
  init: (root: string, branch: string) => invokeSubstrate<void>("git_init", { root, branch }),
  stashList: (root: string) => invokeSubstrate<StashInfo[]>("git_stash_list", { root }),
  stashPush: (root: string, message: string, mode: StashMode) => invokeSubstrate<void>("git_stash_push", { root, message, mode }),
  stashOp: (root: string, index: number, op: "apply" | "pop" | "drop") => invokeSubstrate<void>("git_stash_op", { root, index, op }),
  configGet: () => invokeSubstrate<GlobalConfig>("git_config_get"),
  configSet: (key: string, value: string) => invokeSubstrate<void>("git_config_set", { key, value }),
};

/** The status letter Git Changes shows for a change, Visual Studio's. */
export function changeLetter(kind: ChangeKind): string {
  switch (kind) {
    case "modified":
    case "typeChanged":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "untracked":
      return "U";
    case "conflicted":
      return "!";
  }
}

/** The change kind spelled out, for tooltips. English, shown through `t`. */
export function changeKindLabel(kind: ChangeKind): string {
  switch (kind) {
    case "modified":
      return "Modified";
    case "typeChanged":
      return "Type changed";
    case "added":
      return "Added";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "copied":
      return "Copied";
    case "untracked":
      return "Untracked";
    case "conflicted":
      return "Conflict";
  }
}

/** A repo-relative path's file name and the folder it's in. */
export function splitRepoPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { name: path, dir: "" } : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}
