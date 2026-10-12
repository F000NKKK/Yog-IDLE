import { useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Button, CheckField, ContextMenu, Icon, IconButton, useContextMenu, useT, type ContextMenuItem } from "substrate-platform-ui";
import { openFile } from "../fileOpenBus";
import { openBranchPicker } from "./BranchPicker";
import { changeKindLabel, changeLetter, gitApi, splitRepoPath, type FileChange, type StashInfo } from "./gitApi";
import { changeDiff, openDiff, openGitRepository } from "./gitDocuments";
import {
  commit,
  commitDraft,
  discard,
  finishOperation,
  gitState,
  initRepository,
  promptNewBranch,
  refreshGit,
  remote,
  stage,
  stashApply,
  stashDrop,
  stashPush,
  unstage,
  useGit,
  type CommitThen,
} from "./gitStore";
import { belowButton } from "./dropdown";
import "./git.css";

export const GIT_CHANGES_PANEL = "gitChanges";

/** Which sections are folded — kept across remounts, like the draft message. */
const collapsed = new Set<string>();

/**
 * Visual Studio's Git Changes window: the branch and its remote actions,
 * the commit message with Commit All / and Push / and Sync, Amend, Stash,
 * then the staged and unstaged changes, conflicts and stashes. Everything
 * acts through `gitStore`; double-clicking a change opens its diff.
 */
export function GitChangesWindow() {
  const t = useT();
  const git = useGit();
  const { status } = git;

  if (!git.root) return <div className="idle-git-empty">{t("Open a folder to use Git.")}</div>;
  if (!git.loaded) return <div className="idle-git-empty">{t("Loading…")}</div>;
  if (git.error) return <div className="idle-git-empty">{git.error}</div>;
  if (!status) {
    return (
      <div className="idle-git-empty">
        <p>{t("This folder isn't in a Git repository.")}</p>
        <Button variant="primary" disabled={!!git.busy} onClick={() => void initRepository()}>
          {t("Create Git Repository...")}
        </Button>
      </div>
    );
  }

  const conflicted = status.conflicted;
  return (
    <div className="idle-git-changes">
      <BranchBar />
      {git.busy && <div className="idle-git-busy">{git.busy}</div>}
      {status.operation && <OperationBanner />}
      <CommitBox />
      <div className="idle-git-lists">
        {conflicted.length > 0 && (
          <Section id="conflicts" title={t("Merge Conflicts")} count={conflicted.length}>
            {conflicted.map((file) => (
              <ChangeRow key={file.path} file={file} list="conflicted" />
            ))}
          </Section>
        )}
        {status.staged.length > 0 && (
          <Section
            id="staged"
            title={t("Staged Changes")}
            count={status.staged.length}
            actions={
              <IconButton size={20} title={t("Unstage All")} onClick={() => void unstage([])}>
                <Icon name="minus" size={13} />
              </IconButton>
            }
          >
            {status.staged.map((file) => (
              <ChangeRow key={file.path} file={file} list="staged" />
            ))}
          </Section>
        )}
        <Section
          id="changes"
          title={t("Changes")}
          count={status.unstaged.length}
          actions={
            status.unstaged.length > 0 && (
              <>
                <IconButton size={20} title={t("Undo All Changes")} onClick={() => void discard(status.unstaged, false)}>
                  <Icon name="undo" size={13} />
                </IconButton>
                <IconButton size={20} title={t("Stage All")} onClick={() => void stage([])}>
                  <Icon name="plus" size={13} />
                </IconButton>
              </>
            )
          }
        >
          {status.unstaged.map((file) => (
            <ChangeRow key={file.path} file={file} list="unstaged" />
          ))}
          {status.unstaged.length === 0 && status.staged.length === 0 && conflicted.length === 0 && (
            <div className="idle-git-note">{t("No changes. The working tree matches the last commit.")}</div>
          )}
        </Section>
        {git.stashes.length > 0 && (
          <Section id="stashes" title={t("Stashes")} count={git.stashes.length}>
            {git.stashes.map((stash) => (
              <StashRow key={stash.index} stash={stash} />
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}

// ── Branch and remote actions ────────────────────────────────────────────────

function BranchBar() {
  const t = useT();
  const { status, busy } = useGit();
  const menu = useContextMenu<void>();
  if (!status) return null;
  const branchLabel = status.branch ?? t("(detached at {hash})", { hash: (status.head ?? "").slice(0, 7) });
  const tracking = status.upstream
    ? t("{branch} tracks {upstream}: {behind} incoming, {ahead} outgoing", { branch: branchLabel, upstream: status.upstream, behind: status.behind, ahead: status.ahead })
    : t("{branch} has no upstream branch.", { branch: branchLabel });
  const disabled = !!busy;
  return (
    <div className="idle-git-toolbar">
      <button type="button" className="idle-git-branch" title={tracking} onClick={openBranchPicker}>
        <Icon name="branch" size={14} />
        <span className="idle-git-branch-name">{branchLabel}</span>
        <Icon name="chevronRight" size={10} className="idle-git-chevron-down" />
      </button>
      <span className="idle-git-spacer" />
      <ToolButton icon="fetch" title={t("Fetch — download incoming commits without changing your files")} disabled={disabled} onClick={() => void remote("fetch")} />
      <ToolButton
        icon="arrowDown"
        count={status.behind}
        title={status.behind > 0 ? t("Pull — {count} incoming commits", { count: status.behind }) : t("Pull — fetch and merge incoming commits")}
        disabled={disabled}
        onClick={() => void remote("pull")}
      />
      <ToolButton
        icon="arrowUp"
        count={status.ahead}
        title={status.ahead > 0 ? t("Push — {count} outgoing commits", { count: status.ahead }) : t("Push — upload your commits")}
        disabled={disabled}
        onClick={() => void remote("push")}
      />
      <ToolButton icon="sync" title={t("Sync (Pull then Push)")} disabled={disabled} onClick={() => void remote("sync")} />
      <ToolButton icon="more" title={t("More Actions")} onClick={(e) => menu.openAtPoint(undefined, belowButton(e))} />
      <ContextMenu
        target={menu.target}
        items={[
          { label: t("Manage Branches"), shortcut: "Ctrl+0 Ctrl+R", onSelect: openGitRepository },
          { label: t("New Branch..."), disabled, onSelect: () => void promptNewBranch() },
          { label: t("Refresh"), separatorBefore: true, onSelect: () => void refreshGit() },
        ]}
        onClose={menu.close}
      />
    </div>
  );
}

/** A Git Changes toolbar button: a 16px icon, and a count beside it when there is one (incoming / outgoing). */
function ToolButton({ icon, count, title, disabled, onClick }: { icon: string; count?: number; title: string; disabled?: boolean; onClick: (e: MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button type="button" className="idle-git-tool" title={title} aria-label={title} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={16} />
      {!!count && <span className="idle-git-tool-count">{count}</span>}
    </button>
  );
}

function OperationBanner() {
  const t = useT();
  const { status, busy } = useGit();
  if (!status?.operation) return null;
  const what: Record<string, string> = {
    merge: "A merge is in progress.",
    rebase: "A rebase is in progress.",
    cherryPick: "A cherry-pick is in progress.",
    revert: "A revert is in progress.",
  };
  const conflicts = status.conflicted.length;
  return (
    <div className="idle-git-banner">
      <Icon name="info" size={14} />
      <span className="idle-git-banner-text">
        {t(what[status.operation])}{" "}
        {conflicts > 0 ? t("Resolve the conflicts in {count} files, stage them, then continue.", { count: conflicts }) : t("All conflicts are resolved.")}
      </span>
      <Button variant="primary" disabled={!!busy || conflicts > 0} onClick={() => void finishOperation(true)}>
        {t("Continue")}
      </Button>
      <Button disabled={!!busy} onClick={() => void finishOperation(false)}>
        {t("Abort")}
      </Button>
    </div>
  );
}

// ── Commit ───────────────────────────────────────────────────────────────────

function CommitBox() {
  const t = useT();
  const { status, busy, root } = useGit();
  const [message, setMessageState] = useState(commitDraft.message);
  const [amend, setAmendState] = useState(commitDraft.amend);
  const menu = useContextMenu<void>();
  const stagedOnly = (status?.staged.length ?? 0) > 0;
  const nothing = !status || (status.staged.length === 0 && status.unstaged.length === 0);

  // The store clears the draft once a commit lands.
  useEffect(() => {
    setMessageState(commitDraft.message);
    setAmendState(commitDraft.amend);
  }, [status]);

  function setMessage(value: string) {
    commitDraft.message = value;
    setMessageState(value);
  }

  function setAmend(value: boolean) {
    commitDraft.amend = value;
    setAmendState(value);
    // Visual Studio fills in the last commit's message to edit.
    if (value && !commitDraft.message.trim() && root) {
      gitApi
        .lastMessage(root)
        .then((last) => {
          if (commitDraft.amend && !commitDraft.message.trim()) setMessage(last);
        })
        .catch(() => {});
    }
  }

  const canCommit = !busy && !!status && (amend ? !!status.head : !nothing && !!message.trim());
  const run = (then: CommitThen) => {
    if (canCommit) void commit(then);
  };

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      run("nothing");
    }
  }

  const commitLabel = amend ? t("Amend") : stagedOnly ? t("Commit Staged") : t("Commit All");
  const items: ContextMenuItem[] = [
    { label: commitLabel, disabled: !canCommit, onSelect: () => run("nothing") },
    { label: amend ? t("Amend and Push") : stagedOnly ? t("Commit Staged and Push") : t("Commit All and Push"), disabled: !canCommit, onSelect: () => run("push") },
    { label: amend ? t("Amend and Sync") : stagedOnly ? t("Commit Staged and Sync") : t("Commit All and Sync"), disabled: !canCommit, onSelect: () => run("sync") },
    { label: t("Stash All"), separatorBefore: true, disabled: nothing || !!busy, onSelect: () => void stashPush("all") },
    { label: t("Stash All and Keep Staged"), disabled: !stagedOnly || !!busy, onSelect: () => void stashPush("keepIndex") },
    { label: t("Stash Staged"), disabled: !stagedOnly || !!busy, onSelect: () => void stashPush("staged") },
  ];

  return (
    <div className="idle-git-commit">
      <textarea
        className="sp-textfield idle-git-message"
        value={message}
        placeholder={t("Enter a message <Required>")}
        rows={4}
        spellCheck={false}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="idle-git-commit-row">
        <div className="idle-git-split">
          <Button variant="primary" disabled={!canCommit} title={t("{action} (Ctrl+Enter)", { action: commitLabel })} onClick={() => run("nothing")}>
            {commitLabel}
          </Button>
          <Button variant="primary" className="idle-git-split-arrow" title={t("More Commit Actions")} onClick={(e) => menu.openAtPoint(undefined, belowButton(e))}>
            <Icon name="chevronRight" size={10} className="idle-git-chevron-down" />
          </Button>
          <ContextMenu target={menu.target} items={items} onClose={menu.close} />
        </div>
        <CheckField checked={amend} disabled={!status?.head} onChange={setAmend} label={t("Amend")} />
      </div>
    </div>
  );
}

// ── Lists ────────────────────────────────────────────────────────────────────

function Section({ id, title, count, actions, children }: { id: string; title: string; count: number; actions?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(!collapsed.has(id));
  function toggle() {
    if (open) collapsed.add(id);
    else collapsed.delete(id);
    setOpen(!open);
  }
  return (
    <div className="idle-git-section">
      <div className="idle-git-section-header" onClick={toggle}>
        <Icon name="chevronRight" size={10} className={open ? "idle-git-chevron-down" : undefined} />
        <span className="idle-git-section-title">{title}</span>
        <span className="idle-git-count">{count}</span>
        <span className="idle-git-spacer" />
        <span className="idle-git-section-actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
      </div>
      {open && <div className="idle-git-section-body">{children}</div>}
    </div>
  );
}

type ListKind = "staged" | "unstaged" | "conflicted";

function ChangeRow({ file, list }: { file: FileChange; list: ListKind }) {
  const t = useT();
  const menu = useContextMenu<void>();
  const { name, dir } = splitRepoPath(file.path);
  const deleted = file.kind === "deleted";
  const staged = list === "staged";

  const showDiff = () => openDiff(changeDiff(file, staged));
  const open = () => openFile({ path: file.absPath });

  function onDoubleClick() {
    if (list === "conflicted") open();
    else showDiff();
  }

  const items: ContextMenuItem[] = [
    { label: t("Open"), disabled: deleted, onSelect: open },
    { label: t("Compare with Unmodified"), disabled: list === "conflicted" || file.kind === "untracked", onSelect: showDiff },
    staged
      ? { label: t("Unstage"), separatorBefore: true, onSelect: () => void unstage([file.path]) }
      : { label: list === "conflicted" ? t("Mark as Resolved (Stage)") : t("Stage"), separatorBefore: true, onSelect: () => void stage([file.path]) },
    { label: t("Undo Changes"), destructive: true, disabled: list === "conflicted", onSelect: () => void discard([file], staged) },
    { label: t("Copy Full Path"), separatorBefore: true, onSelect: () => void navigator.clipboard.writeText(file.absPath) },
  ];

  const title = `${file.origPath ? `${file.origPath} → ` : ""}${file.path}\n${t(changeKindLabel(file.kind))}`;
  return (
    <div
      className="idle-git-row"
      title={title}
      tabIndex={0}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => e.key === "Enter" && onDoubleClick()}
      onContextMenu={(e: MouseEvent) => menu.openAtPoint(undefined, e)}
    >
      <span className={`idle-git-letter idle-git-kind-${file.kind}`}>{changeLetter(file.kind)}</span>
      <span className={`idle-git-name${deleted ? " idle-git-deleted" : ""}`}>{name}</span>
      {dir && <span className="idle-git-dir">{dir}</span>}
      <span className="idle-git-row-actions">
        {list !== "conflicted" && !staged && (
          <IconButton size={18} title={t("Undo Changes")} onClick={() => void discard([file], false)}>
            <Icon name="undo" size={12} />
          </IconButton>
        )}
        {staged ? (
          <IconButton size={18} title={t("Unstage")} onClick={() => void unstage([file.path])}>
            <Icon name="minus" size={12} />
          </IconButton>
        ) : (
          <IconButton size={18} title={list === "conflicted" ? t("Mark as Resolved (Stage)") : t("Stage")} onClick={() => void stage([file.path])}>
            <Icon name="plus" size={12} />
          </IconButton>
        )}
      </span>
      <ContextMenu target={menu.target} items={items} onClose={menu.close} />
    </div>
  );
}

function StashRow({ stash }: { stash: StashInfo }) {
  const t = useT();
  const menu = useContextMenu<void>();
  const busy = !!gitState().busy;
  const items: ContextMenuItem[] = [
    { label: t("Apply"), disabled: busy, onSelect: () => void stashApply(stash.index, false) },
    { label: t("Pop"), disabled: busy, onSelect: () => void stashApply(stash.index, true) },
    { label: t("Drop"), destructive: true, separatorBefore: true, disabled: busy, onSelect: () => void stashDrop(stash.index) },
  ];
  return (
    <div className="idle-git-row" title={`stash@{${stash.index}}: ${stash.message}`} onContextMenu={(e: MouseEvent) => menu.openAtPoint(undefined, e)}>
      <Icon name="stash" size={13} />
      <span className="idle-git-name">{stash.message}</span>
      <span className="idle-git-dir">{`stash@{${stash.index}}`}</span>
      <span className="idle-git-row-actions">
        <IconButton size={18} title={t("Apply")} onClick={() => void stashApply(stash.index, false)}>
          <Icon name="check" size={12} />
        </IconButton>
        <IconButton size={18} title={t("Pop")} onClick={() => void stashApply(stash.index, true)}>
          <Icon name="arrowUp" size={12} />
        </IconButton>
        <IconButton size={18} title={t("Drop")} onClick={() => void stashDrop(stash.index)}>
          <Icon name="trash" size={12} />
        </IconButton>
      </span>
      <ContextMenu target={menu.target} items={items} onClose={menu.close} />
    </div>
  );
}
