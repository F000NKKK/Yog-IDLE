import { StatusBarButton, useShell, useT } from "substrate-platform-ui";
import { openBranchPicker } from "./BranchPicker";
import { GIT_CHANGES_PANEL } from "./GitChangesWindow";
import { initRepository, useGit } from "./gitStore";

/**
 * The status bar's Git indicators, Visual Studio's bottom-right: outgoing /
 * incoming commits, pending changes (opens Git Changes), and the branch
 * (opens the branch picker) — or "Add to Source Control" outside a repository.
 */
export function GitStatusBar() {
  const t = useT();
  const shell = useShell();
  const { root, status, loaded } = useGit();
  if (!root || !loaded) return null;
  if (!status) return <StatusBarButton icon="plus" label={t("Add to Source Control")} title={t("Create Git Repository...")} onClick={() => void initRepository()} />;
  const pending = status.staged.length + status.unstaged.length + status.conflicted.length;
  const branch = status.branch ?? (status.head ? status.head.slice(0, 7) : "HEAD");
  return (
    <>
      {status.upstream && (status.ahead > 0 || status.behind > 0) && (
        <StatusBarButton
          label={`↑${status.ahead} ↓${status.behind}`}
          title={t("{ahead} outgoing / {behind} incoming commits", { ahead: status.ahead, behind: status.behind })}
          onClick={() => shell.showToolWindow(GIT_CHANGES_PANEL)}
        />
      )}
      <StatusBarButton
        icon="file"
        label={String(pending)}
        title={t("{count} pending changes", { count: pending })}
        onClick={() => shell.showToolWindow(GIT_CHANGES_PANEL)}
      />
      <StatusBarButton icon="branch" label={branch} title={t("Branch: {branch}. Click to switch branches.", { branch })} onClick={openBranchPicker} />
    </>
  );
}
