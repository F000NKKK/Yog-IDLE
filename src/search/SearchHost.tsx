import { useEffect } from "react";
import { useFindRequest, useKeybinding, useShell } from "substrate-platform-ui";
import { CodeSearch } from "./CodeSearch";
import { CODE_SEARCH_PANEL, openCodeSearch, showCodeSearchPopup, useSearchUi } from "./searchUi";

/**
 * Code Search (Ctrl+T, Ctrl+,) — its keybinding, and bringing it up: a
 * popup unless it's been docked. Find in Files is Substrate's (`FindHost`).
 */
export function SearchHost() {
  const ui = useSearchUi();
  const shell = useShell();
  const findRequest = useFindRequest();
  useKeybinding(["Ctrl+T", "Ctrl+,"], () => openCodeSearch(), { id: "edit.codeSearch" });

  // Find in Files takes over from the popup.
  useEffect(() => {
    if (findRequest) showCodeSearchPopup(false);
  }, [findRequest]);

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

export { CODE_SEARCH_PANEL } from "./searchUi";
export { CodeSearchPanel } from "./CodeSearch";
