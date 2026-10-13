import { useEffect } from "react";
import { useKeybinding, useShell } from "substrate-platform-ui";
import { CodeSearch } from "./CodeSearch";
import { CODE_SEARCH_PANEL, FIND_IN_FILES_PANEL, openCodeSearch, openFindInFiles, showCodeSearchPopup, useSearchUi } from "./searchUi";

/**
 * Find in Files (Ctrl+Shift+F), Replace in Files (Ctrl+Shift+H) and Code
 * Search (Ctrl+T, Ctrl+,) — their keybindings, and bringing up their
 * windows: Find and Replace is a tool window (floating at first, dockable
 * like any other), Code Search a popup unless it's been docked.
 */
export function SearchHost() {
  const ui = useSearchUi();
  const shell = useShell();
  useKeybinding("Ctrl+Shift+F", () => openFindInFiles("find"), { id: "edit.findInFiles" });
  useKeybinding("Ctrl+Shift+H", () => openFindInFiles("replace"), { id: "edit.replaceInFiles" });
  useKeybinding(["Ctrl+T", "Ctrl+,"], () => openCodeSearch(), { id: "edit.codeSearch" });

  useEffect(() => {
    if (ui.find) shell.showToolWindow(FIND_IN_FILES_PANEL);
    // Only on a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.find?.seq]);

  useEffect(() => {
    if (!ui.codeSearch) return;
    if (shell.isToolWindowVisible(CODE_SEARCH_PANEL)) shell.showToolWindow(CODE_SEARCH_PANEL);
    else showCodeSearchPopup(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.codeSearch?.seq]);

  return ui.codeSearchPopup ? (
    <CodeSearch
      key={ui.codeSearch?.seq}
      onClose={() => showCodeSearchPopup(false)}
      onDock={() => {
        showCodeSearchPopup(false);
        shell.showToolWindow(CODE_SEARCH_PANEL);
      }}
    />
  ) : null;
}

export { FIND_IN_FILES_PANEL, CODE_SEARCH_PANEL } from "./searchUi";
export { FindResultsPanel } from "./FindResultsPanel";
export { FindInFilesWindow } from "./FindInFilesWindow";
export { CodeSearchPanel } from "./CodeSearch";
export { FIND_RESULTS_PANEL } from "./FindInFilesWindow";
