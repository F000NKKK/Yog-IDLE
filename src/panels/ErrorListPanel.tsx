import { useMemo } from "react";
import { ErrorList, errorText, openLink, useDiagnostics, type Diagnostic } from "substrate-platform-ui";
import { openFile } from "../fileOpenBus";
import { useActiveFileTab, useOpenFiles } from "../OpenFilesContext";
import { reportError } from "../reportError";

function navigate(d: Diagnostic) {
  if (d.file) openFile({ path: d.file, line: d.line, column: d.column });
}

function openHelp(href: string) {
  openLink(href).catch((err) => reportError(errorText(err)));
}

/** The Error List tool window: the last build's and the on-save checks' diagnostics. */
export function ErrorListPanel() {
  const diagnostics = useDiagnostics();
  const { tabs } = useOpenFiles();
  const active = useActiveFileTab();
  const openFiles = useMemo(() => tabs.map((tab) => tab.path), [tabs]);
  return <ErrorList diagnostics={diagnostics} onNavigate={navigate} activeFile={active?.path ?? null} openFiles={openFiles} onOpenHelp={openHelp} />;
}
