import { useMemo, useSyncExternalStore, type ComponentType } from "react";
import { t, useLocale, type PanelDef } from "substrate-platform-ui";
import type { CommitInfo, DiffSide, FileChange } from "./gitApi";
import { DiffDocument } from "./DiffDocument";
import { GitRepositoryWindow } from "./GitRepositoryWindow";

/**
 * The Git documents in the center dock beside the file tabs — Visual
 * Studio's Git Repository window and diff tabs. Module-level so Git
 * Changes, the menu and the history can open them from anywhere; `App`
 * feeds `useGitPanels()` into the shell next to the open files' panels.
 */

/** A diff to show: two sides of one file (renames may differ in path). */
export interface DiffRequest {
  /** The file on disk, for Open File. */
  absPath: string;
  left: DiffSide;
  right: DiffSide;
  /** Labels for the two sides ("HEAD", "Working Tree", a commit). */
  leftLabel: string;
  rightLabel: string;
}

const GIT_REPOSITORY_PANEL = "git-repository";
const DIFF_PREFIX = "git-diff:";

interface GitDocument {
  id: string;
  diff?: DiffRequest;
}

let documents: GitDocument[] = [];
const subscribers = new Set<() => void>();
const components = new Map<string, ComponentType>();
/** Bumped to bring an already-open document to the front again. */
let revealSeq = 0;
let revealed: { id: string; seq: number } | null = null;

function changed() {
  subscribers.forEach((notify) => notify());
}

function subscribe(notify: () => void) {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

function open(doc: GitDocument) {
  if (!documents.some((d) => d.id === doc.id)) documents = [...documents, doc];
  revealed = { id: doc.id, seq: ++revealSeq };
  changed();
}

/** Opens a diff tab (or brings the same diff's tab back to the front). */
export function openDiff(diff: DiffRequest): void {
  open({ id: `${DIFF_PREFIX}${diff.left.rev}|${diff.right.rev}|${diff.right.path || diff.left.path}`, diff });
}

/** Git > Manage Branches / View Branch History. */
export function openGitRepository(): void {
  open({ id: GIT_REPOSITORY_PANEL });
}

export function isGitDocument(id: string): boolean {
  return id === GIT_REPOSITORY_PANEL || id.startsWith(DIFF_PREFIX);
}

export function closeGitDocument(id: string): void {
  documents = documents.filter((d) => d.id !== id);
  components.delete(id);
  changed();
}

/** The latest request to show a Git document — `GitHost` activates it in the center dock. */
export function useRevealedGitDocument(): { id: string; seq: number } | null {
  return useSyncExternalStore(subscribe, () => revealed);
}

function componentFor(doc: GitDocument): ComponentType {
  let component = components.get(doc.id);
  if (!component) {
    const diff = doc.diff;
    component = diff ? () => <DiffDocument request={diff} /> : GitRepositoryWindow;
    components.set(doc.id, component);
  }
  return component;
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** One `PanelDef` per open Git document, for `PlatformShell`'s `extraCenterPanels`. */
export function useGitPanels(): PanelDef[] {
  const docs = useSyncExternalStore(subscribe, () => documents);
  const locale = useLocale();
  return useMemo(
    () =>
      docs.map((doc) => {
        const diff = doc.diff;
        if (!diff) return { id: doc.id, title: t("Git Repository"), component: componentFor(doc) };
        const path = diff.right.path || diff.left.path;
        return {
          id: doc.id,
          title: t("{name}: {left} vs. {right}", { name: baseName(path), left: diff.leftLabel, right: diff.rightLabel }),
          tooltip: `${path}\n${diff.leftLabel} ↔ ${diff.rightLabel}`,
          component: componentFor(doc),
          contextMenu: () => [
            { label: t("Close"), onSelect: () => closeGitDocument(doc.id) },
            { label: t("Close All Diffs"), onSelect: () => docs.filter((d) => d.diff).forEach((d) => closeGitDocument(d.id)) },
          ],
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docs, locale],
  );
}

/** The diff Git Changes opens for a change: unstaged — what's staged vs. the file on disk; staged — the last commit vs. what's staged. */
export function changeDiff(file: FileChange, staged: boolean): DiffRequest {
  const before = file.origPath ?? file.path;
  if (staged) {
    const added = file.kind === "added" || file.kind === "copied";
    return {
      absPath: file.absPath,
      left: { rev: added ? "" : "HEAD", path: before },
      right: { rev: file.kind === "deleted" ? "" : "INDEX", path: file.path },
      leftLabel: "HEAD",
      rightLabel: t("Staged"),
    };
  }
  if (file.kind === "conflicted") {
    return { absPath: file.absPath, left: { rev: "HEAD", path: file.path }, right: { rev: "WORKTREE", path: file.path }, leftLabel: "HEAD", rightLabel: t("Working Tree") };
  }
  return {
    absPath: file.absPath,
    left: { rev: file.kind === "untracked" ? "" : "INDEX", path: file.path },
    right: { rev: file.kind === "deleted" ? "" : "WORKTREE", path: file.path },
    leftLabel: t("Index"),
    rightLabel: t("Working Tree"),
  };
}

/** A file as one commit changed it, against the commit's first parent. */
export function commitDiff(file: FileChange, commit: CommitInfo): DiffRequest {
  const parent = commit.parents[0];
  const short = commit.shortHash;
  return {
    absPath: file.absPath,
    left: { rev: parent && file.kind !== "added" ? parent : "", path: file.origPath ?? file.path },
    right: { rev: file.kind === "deleted" ? "" : commit.hash, path: file.path },
    leftLabel: parent ? parent.slice(0, short.length) : t("(none)"),
    rightLabel: short,
  };
}
