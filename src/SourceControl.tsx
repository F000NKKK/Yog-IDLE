import { useMemo, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { SourceControlProvider, type SourceControlHost } from "substrate-platform-ui";
import { useOpenFiles } from "./OpenFilesContext";
import { useProject } from "./ProjectContext";

/** Source Control (Substrate's) over Yog IDLE's project and open files. */
export function SourceControl({ children }: { children: ReactNode }) {
  const { project, openPath } = useProject();
  const { tabs, recheckDisk, confirmUnsaved } = useOpenFiles();
  const root = project?.root ?? null;
  const host = useMemo<SourceControlHost>(
    () => ({
      root,
      openFiles: tabs,
      reloadFromDisk: () => recheckDisk(),
      confirmUnsaved,
      openFolder: (folder) => openPath(folder, "folder"),
      chooseFolder: async (title) => {
        const folder = await open({ directory: true, title });
        return typeof folder === "string" ? folder : null;
      },
    }),
    [root, tabs, recheckDisk, confirmUnsaved, openPath],
  );
  return <SourceControlProvider host={host}>{children}</SourceControlProvider>;
}
