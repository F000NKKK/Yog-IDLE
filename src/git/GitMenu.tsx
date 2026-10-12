import { open } from "@tauri-apps/plugin-dialog";
import { MenuBarItem, confirmDialog, promptDialog, useShell, useT } from "substrate-platform-ui";
import { useOpenFiles } from "../OpenFilesContext";
import { useProject } from "../ProjectContext";
import { openBranchPicker } from "./BranchPicker";
import { GIT_CHANGES_PANEL } from "./GitChangesWindow";
import { openGitRepository } from "./gitDocuments";
import { cloneRepository, initRepository, openGitSettings, promptNewBranch, remote, useGit } from "./gitStore";

/**
 * Visual Studio's Git menu: commit (Git Changes), the remote operations,
 * branches and history (Git Repository), clone/create, and Git's options.
 */
export function GitMenu() {
  const t = useT();
  const shell = useShell();
  const { status, busy, root } = useGit();
  const { openPath } = useProject();
  const { confirmUnsaved } = useOpenFiles();
  const repo = !!status;
  const idle = repo && !busy;

  async function clone() {
    const url = await promptDialog({
      title: t("Clone a Repository"),
      label: t("Repository location:"),
      placeholder: "https://github.com/owner/repo.git",
      confirmLabel: t("Next"),
      validate: (value) => (value.trim() ? null : ""),
    });
    if (!url) return;
    const parent = await open({ directory: true, title: t("Choose the folder to clone into") });
    if (typeof parent !== "string") return;
    const dest = await cloneRepository(url.trim(), parent);
    if (!dest) return;
    const openIt = await confirmDialog({
      title: t("Clone a Repository"),
      message: t("Cloned into {folder}. Open it now?", { folder: dest }),
      confirmLabel: t("Open"),
    });
    if (openIt && (await confirmUnsaved())) await openPath(dest, "folder");
  }

  return (
    <MenuBarItem
      label={t("Git")}
      items={[
        { label: t("Commit or Stash..."), shortcut: "Ctrl+0, Ctrl+G", disabled: !root, onClick: () => shell.showToolWindow(GIT_CHANGES_PANEL) },
        { label: t("Fetch"), separatorBefore: true, disabled: !idle, onClick: () => void remote("fetch") },
        { label: t("Pull"), disabled: !idle, onClick: () => void remote("pull") },
        { label: t("Push"), disabled: !idle, onClick: () => void remote("push") },
        { label: t("Sync (Pull then Push)"), disabled: !idle, onClick: () => void remote("sync") },
        { label: t("New Branch..."), separatorBefore: true, disabled: !idle, onClick: () => void promptNewBranch() },
        { label: t("Switch Branch..."), disabled: !idle, onClick: openBranchPicker },
        { label: t("Manage Branches"), shortcut: "Ctrl+0, Ctrl+R", disabled: !repo, onClick: openGitRepository },
        { label: t("View Branch History"), disabled: !repo, onClick: openGitRepository },
        { label: t("Clone Repository..."), separatorBefore: true, disabled: !!busy, onClick: () => void clone() },
        { label: t("Create Git Repository..."), disabled: !root || repo || !!busy, onClick: () => void initRepository() },
        { label: t("Settings"), separatorBefore: true, onClick: openGitSettings },
      ]}
    />
  );
}
