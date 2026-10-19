import { useMemo, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { IdeHostProvider, type IdeHost as Host } from "substrate-platform-ui";
import { useOpenFiles } from "./OpenFilesContext";
import { useProject } from "./ProjectContext";

/** Substrate's modules (Source Control, Find in Files) over Yog IDLE's project and open files. */
export function IdeHost({ children }: { children: ReactNode }) {
  const { project, openPath } = useProject();
  const { tabs, updateContent, recheckDisk, confirmUnsaved } = useOpenFiles();
  const root = project?.root ?? null;
  const host = useMemo<Host>(
    () => ({
      root,
      documents: tabs,
      setText: updateContent,
      reloadFromDisk: () => recheckDisk(),
      confirmUnsaved,
      openFolder: (folder) => openPath(folder, "folder"),
      chooseFolder: async (title) => {
        const folder = await open({ directory: true, title });
        return typeof folder === "string" ? folder : null;
      },
    }),
    [root, tabs, updateContent, recheckDisk, confirmUnsaved, openPath],
  );
  return <IdeHostProvider host={host}>{children}</IdeHostProvider>;
}
