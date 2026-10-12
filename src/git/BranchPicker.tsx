import { useMemo, useState, useSyncExternalStore } from "react";
import { Icon, QuickPick, useT, type QuickPickItem } from "substrate-platform-ui";
import type { BranchInfo } from "./gitApi";
import { gitState, promptNewBranch, switchBranch, useGit } from "./gitStore";

/**
 * The branch picker — Visual Studio's branch dropdown in Git Changes and the
 * status bar: type to filter local and remote branches, Enter checks one
 * out; "New Branch…" on top. A popup requested from anywhere
 * (`openBranchPicker`), rendered once by `GitHost`.
 */
let pickerOpen = false;
const subscribers = new Set<() => void>();

function setOpen(open: boolean) {
  pickerOpen = open;
  subscribers.forEach((notify) => notify());
}

export function openBranchPicker(): void {
  if (gitState().status) setOpen(true);
}

/** A remote branch's local counterpart name: `origin/feature/x` → `feature/x`. */
export function localNameOf(remoteBranch: string): string {
  const slash = remoteBranch.indexOf("/");
  return slash < 0 ? remoteBranch : remoteBranch.slice(slash + 1);
}

/** Checks out `branch` — a remote one as its local tracking branch (the existing one, if there is). */
export function checkoutBranch(branch: BranchInfo): void {
  if (branch.current) return;
  if (!branch.remote) {
    void switchBranch(branch.name, false);
    return;
  }
  const local = localNameOf(branch.name);
  const existing = gitState().branches.some((b) => !b.remote && b.name === local);
  void (existing ? switchBranch(local, false) : switchBranch(branch.name, true));
}

interface BranchItem extends QuickPickItem {
  branch: BranchInfo | null;
}

const NEW_BRANCH_KEY = "\0new";

export function BranchPickerHost() {
  const open = useSyncExternalStore(
    (notify) => {
      subscribers.add(notify);
      return () => subscribers.delete(notify);
    },
    () => pickerOpen,
  );
  return open ? <BranchPicker onClose={() => setOpen(false)} /> : null;
}

function matchPositions(label: string, query: string): number[] | null {
  if (!query) return [];
  const at = label.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return null;
  return Array.from({ length: query.length }, (_, i) => at + i);
}

function BranchPicker({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { branches } = useGit();
  const [query, setQuery] = useState("");
  const items = useMemo(() => {
    const list: BranchItem[] = [];
    if (!query) list.push({ key: NEW_BRANCH_KEY, label: t("New Branch…"), icon: <Icon name="plus" size={14} />, branch: null });
    for (const branch of branches) {
      if (branch.remote && branch.name.endsWith("/HEAD")) continue;
      const highlights = matchPositions(branch.name, query.trim());
      if (!highlights) continue;
      const tracking = branch.ahead || branch.behind ? `↓${branch.behind} ↑${branch.ahead}` : undefined;
      list.push({
        key: `${branch.remote ? "r" : "l"}:${branch.name}`,
        label: branch.name,
        highlights,
        icon: <Icon name={branch.current ? "check" : "branch"} size={14} />,
        description: branch.remote ? t("remote") : tracking,
        detail: branch.subject,
        branch,
      });
    }
    return list;
  }, [branches, query, t]);

  return (
    <QuickPick<BranchItem>
      query={query}
      onQueryChange={setQuery}
      placeholder={t("Filter branches")}
      items={items}
      emptyText={t("No branches match.")}
      onAccept={(item) => {
        onClose();
        if (item.branch) checkoutBranch(item.branch);
        else void promptNewBranch();
      }}
      onClose={onClose}
    />
  );
}
