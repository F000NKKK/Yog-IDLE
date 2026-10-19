import { useSyncExternalStore } from "react";

// Requests for Code Search — made from keybindings and the Edit menu,
// carried out by `SearchHost` (which can reach the shell). Module-level so
// the menu needn't reach the host.

/** Code Search docked as a tool window (declared in `App`). */
export const CODE_SEARCH_PANEL = "codeSearch";

interface SearchUiState {
  /** The last Code Search request (Ctrl+T). */
  codeSearch: { seq: number } | null;
  /** Code Search is up as a popup (rather than docked as a tool window). */
  codeSearchPopup: boolean;
}

let state: SearchUiState = { codeSearch: null, codeSearchPopup: false };
let seq = 0;
const subscribers = new Set<() => void>();

function set(next: Partial<SearchUiState>) {
  state = { ...state, ...next };
  subscribers.forEach((notify) => notify());
}

export function useSearchUi(): SearchUiState {
  return useSyncExternalStore(
    (notify) => {
      subscribers.add(notify);
      return () => subscribers.delete(notify);
    },
    () => state,
  );
}

/** Edit > Go To > Code Search (Ctrl+T, Ctrl+,) — the popup, or the docked window if that's open. */
export function openCodeSearch(): void {
  set({ codeSearch: { seq: ++seq } });
}

export function showCodeSearchPopup(show: boolean): void {
  set({ codeSearchPopup: show });
}

/** Code Search's text, its `f:`/`t:`/... prefix included — kept across its remounts and reopenings. */
export const searchDrafts = {
  codeQuery: "",
};
