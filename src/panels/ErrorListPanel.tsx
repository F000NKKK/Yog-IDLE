import { useMemo } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ErrorList, t, useDiagnostics, type Diagnostic } from "substrate-platform-ui";
import { openFile } from "../fileOpenBus";
import { useActiveFileTab, useOpenFiles } from "../OpenFilesContext";
import { reportError } from "../reportError";

function navigate(d: Diagnostic) {
  if (d.file) openFile({ path: d.file, line: d.line, column: d.column });
}

function openHelp(href: string) {
  openUrl(href).catch((err) => reportError(t("Couldn't open {target}: {error}", { target: href, error: String(err) })));
}

/** The Error List tool window: the last build's and the on-save checks' diagnostics. */
export function ErrorListPanel() {
  const diagnostics = useDiagnostics();
  const { tabs } = useOpenFiles();
  const active = useActiveFileTab();
  const openFiles = useMemo(() => tabs.map((tab) => tab.path), [tabs]);
  return <ErrorList diagnostics={diagnostics} onNavigate={navigate} activeFile={active?.path ?? null} openFiles={openFiles} onOpenHelp={openHelp} />;
}
