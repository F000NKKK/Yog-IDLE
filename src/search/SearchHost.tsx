import { useKeybinding } from "substrate-platform-ui";
import { CodeSearch } from "./CodeSearch";
import { FindInFilesWindow } from "./FindInFilesWindow";
import { closeCodeSearch, closeFindInFiles, openCodeSearch, openFindInFiles, useSearchUi } from "./searchUi";

/**
 * Find in Files (Ctrl+Shift+F), Replace in Files (Ctrl+Shift+H) and Code
 * Search (Ctrl+T, Ctrl+,) — their keybindings, and whichever of the
 * windows is open. Rendered inside the shell (it shows Find Results).
 */
export function SearchHost() {
  const ui = useSearchUi();
  useKeybinding("Ctrl+Shift+F", () => openFindInFiles("find"), { id: "edit.findInFiles" });
  useKeybinding("Ctrl+Shift+H", () => openFindInFiles("replace"), { id: "edit.replaceInFiles" });
  useKeybinding(["Ctrl+T", "Ctrl+,"], () => openCodeSearch(), { id: "edit.codeSearch" });
  return (
    <>
      {ui.findWindow && <FindInFilesWindow mode={ui.findWindow.mode} seq={ui.findWindow.seq} onClose={closeFindInFiles} />}
      {ui.codeSearch && <CodeSearch key={ui.codeSearch.seq} onClose={closeCodeSearch} />}
    </>
  );
}

export { openCodeSearch, openFindInFiles } from "./searchUi";
export { FindResultsPanel } from "./FindResultsPanel";
export { FIND_RESULTS_PANEL } from "./FindInFilesWindow";
