import { useSyncExternalStore } from "react";
import { confirmDialog, notify, promptDialog, t, errorText } from "substrate-platform-ui";
import { EVENT } from "../events";
import { setOutputSource } from "../outputSource";
import { reportError } from "../reportError";
import { gitApi, type BranchInfo, type FileChange, type RemoteOp, type RepoStatus, type StashInfo, type StashMode } from "./gitApi";

/**
 * The open project's repository as Git Changes, Git Repository, the Git
 * menu and the status bar all see it — module-level, like the search
 * stores, since those live in unrelated parts of the dock tree. `GitHost`
 * points it at the project and keeps it fresh (window focus, saves, a slow
 * poll); every operation here refreshes it once done.
 */
interface GitState {
  /** The project folder the repository is looked up from. */
  root: string | null;
  /** `null` — no project, or it isn't in a repository. */
  status: RepoStatus | null;
  /** The first status for `root` has arrived. */
  loaded: boolean;
  /** Why the status couldn't be read (git missing, a broken repository). */
  error: string | null;
  /** What's running now ("Pushing…") — one operation at a time. */
  busy: string | null;
  /** Bumped on every refresh, so views that read from the repository themselves (a diff, the history) know to re-read. */
  revision: number;
  branches: BranchInfo[];
  stashes: StashInfo[];
}

let state: GitState = { root: null, status: null, loaded: false, error: null, busy: null, revision: 0, branches: [], stashes: [] };
const subscribers = new Set<() => void>();

function set(next: Partial<GitState>) {
  state = { ...state, ...next };
  subscribers.forEach((notify) => notify());
}

export function useGit(): GitState {
  return useSyncExternalStore(
    (notify) => {
      subscribers.add(notify);
      return () => subscribers.delete(notify);
    },
    () => state,
  );
}

export function gitState(): GitState {
  return state;
}

/** The commit message being written in Git Changes — kept across its remounts (moving it to another dock) and reopenings. */
export const commitDraft = {
  message: "",
  amend: false,
  /** What ticking Amend put into the message (the last commit's message, plus a separator when it went in front of existing text) — taken back out on unticking if still there. */
  amendInserted: null as string | null,
};

/** Points the store at another project (or none). */
export function setGitRoot(root: string | null): void {
  if (root === state.root) return;
  set({ root, status: null, loaded: false, error: null, branches: [], stashes: [] });
  void refreshGit();
}

let refreshSeq = 0;

/** Re-reads status, branches and stashes. Quietly ignores an answer for a project that's no longer open. */
export async function refreshGit(): Promise<void> {
  const root = state.root;
  const seq = ++refreshSeq;
  if (!root) {
    set({ status: null, loaded: true, error: null, revision: state.revision + 1 });
    return;
  }
  try {
    const status = await gitApi.status(root);
    const [branches, stashes] = status ? await Promise.all([gitApi.branches(root), gitApi.stashList(root)]) : [[], []];
    if (seq !== refreshSeq || root !== state.root) return;
    set({ status, branches, stashes, loaded: true, error: null, revision: state.revision + 1 });
  } catch (err) {
    if (seq !== refreshSeq || root !== state.root) return;
    set({ status: null, loaded: true, error: errorText(err), revision: state.revision + 1 });
  }
}

interface RunOptions {
  /** Streams output — switch Output to Source Control. */
  output?: boolean;
}

/**
 * Runs one operation against the repository: shown as `label` while it
 * runs, its failure reported, the status refreshed after. Resolves whether
 * it succeeded; refused (with a message) while another one is running.
 */
async function runGit<T>(label: string, action: (root: string) => Promise<T>, options: RunOptions = {}): Promise<T | undefined> {
  const root = state.status ? state.root : null;
  if (!root) return undefined;
  if (state.busy) {
    notify({ level: "info", message: t("Wait for \"{operation}\" to finish first.", { operation: state.busy }) });
    return undefined;
  }
  set({ busy: label });
  if (options.output) setOutputSource("git");
  try {
    return await action(root);
  } catch (err) {
    reportError(errorText(err), EVENT.gitOutput);
    return undefined;
  } finally {
    set({ busy: null });
    await refreshGit();
  }
}

// ── Operations ───────────────────────────────────────────────────────────────

export const stage = (paths: string[]) => runGit(t("Staging…"), (root) => gitApi.stage(root, paths));
export const unstage = (paths: string[]) => runGit(t("Unstaging…"), (root) => gitApi.unstage(root, paths));

/** Undo Changes — after asking, since it can't be undone. */
export async function discard(files: FileChange[], staged: boolean): Promise<void> {
  if (files.length === 0) return;
  const ok = await confirmDialog({
    title: t("Undo Changes"),
    message:
      files.length === 1
        ? t("Undo the changes to {name}? They will be lost.", { name: files[0].path })
        : t("Undo the changes to {count} files? They will be lost.", { count: files.length }),
    confirmLabel: t("Undo Changes"),
  });
  if (!ok) return;
  await runGit(t("Undoing changes…"), (root) =>
    gitApi.discard(
      root,
      files.map((f) => ({ path: f.path, origPath: f.origPath, kind: f.kind, staged })),
    ),
  );
}

const REMOTE_LABELS: Record<RemoteOp, string> = {
  fetch: "Fetching…",
  pull: "Pulling…",
  push: "Pushing…",
  sync: "Syncing…",
};

const REMOTE_DONE: Record<RemoteOp, string> = {
  fetch: "Fetched.",
  pull: "Pulled.",
  push: "Pushed.",
  sync: "Synced.",
};

export async function remote(op: RemoteOp): Promise<boolean> {
  const done = await runGit(t(REMOTE_LABELS[op]), (root) => gitApi.remote(root, op).then(() => true), { output: true });
  if (done) notify({ level: "info", message: t(REMOTE_DONE[op]) });
  return !!done;
}

export type CommitThen = "nothing" | "push" | "sync";

/**
 * Commit Staged — or Commit All when nothing is staged — then optionally
 * push or sync. Clears the message once committed.
 */
export async function commit(then: CommitThen = "nothing"): Promise<void> {
  const status = state.status;
  if (!status) return;
  const message = commitDraft.message.trim();
  if (!message && !commitDraft.amend) {
    notify({ level: "warn", message: t("Enter a commit message.") });
    return;
  }
  const stageAll = status.staged.length === 0;
  const result = await runGit(t("Committing…"), (root) => gitApi.commit(root, commitDraft.message, commitDraft.amend, stageAll));
  if (!result) return;
  commitDraft.message = "";
  commitDraft.amend = false;
  commitDraft.amendInserted = null;
  set({});
  notify({ level: "info", message: t("Commit {hash} created locally.", { hash: result.hash }) });
  if (then !== "nothing") await remote(then === "push" ? "push" : "sync");
}

export const switchBranch = (name: string, isRemote: boolean) =>
  runGit(t("Checking out {branch}…", { branch: name }), (root) => gitApi.switchTo(root, name, isRemote));

const createBranch = (name: string, start: string, checkout: boolean) =>
  runGit(t("Creating branch {branch}…", { branch: name }), (root) => gitApi.createBranch(root, name, start, checkout));

/** Why `name` can't be a branch name (`git check-ref-format`'s rules, roughly), or `null`. */
function branchNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "";
  if (/[\s~^:?*[\\]|\.\.|@\{|\/\/|^[-/.]|[/.]$|\.lock$|^@$/.test(n)) return t("That isn't a valid branch name.");
  if (state.branches.some((b) => !b.remote && b.name === n)) return t("A branch named {branch} already exists.", { branch: n });
  return null;
}

/** Git > New Branch — asks for a name, creates it from `start` (default: what's checked out) and checks it out. */
export async function promptNewBranch(start?: string): Promise<void> {
  if (!state.status) return;
  const base = start ?? state.status.branch ?? state.status.head ?? "HEAD";
  const name = await promptDialog({
    title: t("Create a New Branch"),
    message: t("Based on: {branch}", { branch: base }),
    label: t("Branch name:"),
    confirmLabel: t("Create"),
    validate: branchNameError,
  });
  if (name) await createBranch(name.trim(), start ?? "", true);
}

export async function deleteBranch(name: string): Promise<void> {
  const ok = await confirmDialog({
    title: t("Delete Branch"),
    message: t("Delete the local branch {branch}?", { branch: name }),
    confirmLabel: t("Delete"),
  });
  if (!ok) return;
  const root = state.root;
  try {
    await runGitOrThrow(t("Deleting branch {branch}…", { branch: name }), (r) => gitApi.deleteBranch(r, name, false));
  } catch (err) {
    // Not merged anywhere — Visual Studio asks again before forcing it.
    const force = await confirmDialog({
      title: t("Delete Branch"),
      message: `${errorText(err)} ${t("Delete {branch} anyway? Its unmerged commits will be lost.", { branch: name })}`,
      confirmLabel: t("Delete"),
    });
    if (force && root === state.root) await runGit(t("Deleting branch {branch}…", { branch: name }), (r) => gitApi.deleteBranch(r, name, true));
  }
}

/** Like `runGit`, but a failure is thrown to the caller instead of reported. */
async function runGitOrThrow(label: string, action: (root: string) => Promise<void>): Promise<void> {
  let failure: unknown = null;
  await runGit(label, async (root) => {
    try {
      await action(root);
    } catch (err) {
      failure = err;
    }
  });
  if (failure !== null) throw failure;
}

export async function mergeIntoCurrent(branch: string): Promise<void> {
  const current = state.status?.branch ?? "HEAD";
  const ok = await confirmDialog({
    title: t("Merge"),
    message: t("Merge {source} into {target}?", { source: branch, target: current }),
    confirmLabel: t("Merge"),
  });
  if (ok) await runGit(t("Merging…"), (root) => gitApi.integrate(root, "merge", branch), { output: true });
}

export async function rebaseOnto(branch: string): Promise<void> {
  const current = state.status?.branch ?? "HEAD";
  const ok = await confirmDialog({
    title: t("Rebase"),
    message: t("Rebase {source} onto {target}? Its commits will be rewritten.", { source: current, target: branch }),
    confirmLabel: t("Rebase"),
  });
  if (ok) await runGit(t("Rebasing…"), (root) => gitApi.integrate(root, "rebase", branch), { output: true });
}

/** Continue or Abort the merge/rebase in progress. */
export const finishOperation = (continue_: boolean) =>
  runGit(continue_ ? t("Continuing…") : t("Aborting…"), (root) => gitApi.operation(root, continue_), { output: true });

export const stashPush = (mode: StashMode) => runGit(t("Stashing…"), (root) => gitApi.stashPush(root, commitDraft.message, mode));

export const stashApply = (index: number, pop: boolean) =>
  runGit(pop ? t("Popping stash…") : t("Applying stash…"), (root) => gitApi.stashOp(root, index, pop ? "pop" : "apply"));

export async function stashDrop(index: number): Promise<void> {
  const ok = await confirmDialog({
    title: t("Drop Stash"),
    message: t("Drop stash@{{index}}? Its changes will be lost.", { index }),
    confirmLabel: t("Drop"),
  });
  if (ok) await runGit(t("Dropping stash…"), (root) => gitApi.stashOp(root, index, "drop"));
}

/** Git > Create Git Repository — `git init` in the open folder. */
export async function initRepository(): Promise<void> {
  const root = state.root;
  if (!root || state.status) return;
  const ok = await confirmDialog({
    title: t("Create Git Repository"),
    message: t("Create a Git repository in {folder}?", { folder: root }),
    confirmLabel: t("Create"),
  });
  if (!ok) return;
  set({ busy: t("Creating repository…") });
  setOutputSource("git");
  try {
    await gitApi.init(root, "");
    notify({ level: "info", message: t("Created a Git repository in {folder}.", { folder: root }) });
  } catch (err) {
    reportError(errorText(err), EVENT.gitOutput);
  } finally {
    set({ busy: null });
    await refreshGit();
  }
}

/** Git > Clone Repository — resolves with the new working tree, or `null`. */
export async function cloneRepository(url: string, parent: string): Promise<string | null> {
  if (state.busy) {
    notify({ level: "info", message: t("Wait for \"{operation}\" to finish first.", { operation: state.busy }) });
    return null;
  }
  set({ busy: t("Cloning…") });
  setOutputSource("git");
  try {
    return await gitApi.clone(url, parent, "");
  } catch (err) {
    reportError(errorText(err), EVENT.gitOutput);
    return null;
  } finally {
    set({ busy: null });
  }
}

// ── Git > Settings ───────────────────────────────────────────────────────────

const settingsListeners = new Set<() => void>();

/** Opens Options on the Source Control page — `App` owns the Options window and listens. */
export function openGitSettings(): void {
  settingsListeners.forEach((listener) => listener());
}

export function onOpenGitSettings(listener: () => void): () => void {
  settingsListeners.add(listener);
  return () => settingsListeners.delete(listener);
}
