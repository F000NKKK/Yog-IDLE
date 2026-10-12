import { useSyncExternalStore } from "react";

// Requests for the search UI — made from keybindings and the Edit menu,
// carried out by `SearchHost` (which can reach the shell). Module-level so
// the menu needn't reach the host.

export type FindWindowMode = "find" | "replace";

/** The Find and Replace tool window's id (declared in `App`). */
export const FIND_IN_FILES_PANEL = "findInFiles";
/** Code Search docked as a tool window (declared in `App`). */
export const CODE_SEARCH_PANEL = "codeSearch";

interface SearchUiState {
  /** The last Find in Files / Replace in Files request; `seq` changes on every one, so a second Ctrl+Shift+F re-seeds the field from the editor. */
  find: { mode: FindWindowMode; seq: number } | null;
  /** The last Code Search request (Ctrl+T). */
  codeSearch: { seq: number } | null;
  /** Code Search is up as a popup (rather than docked as a tool window). */
  codeSearchPopup: boolean;
}

let state: SearchUiState = { find: null, codeSearch: null, codeSearchPopup: false };
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

/** Edit > Find and Replace > Find in Files (Ctrl+Shift+F) / Replace in Files (Ctrl+Shift+H). */
export function openFindInFiles(mode: FindWindowMode): void {
  set({ find: { mode, seq: ++seq }, codeSearchPopup: false });
}

/** Edit > Go To > Code Search (Ctrl+T, Ctrl+,) — the popup, or the docked window if that's open. */
export function openCodeSearch(): void {
  set({ codeSearch: { seq: ++seq } });
}

export function showCodeSearchPopup(show: boolean): void {
  set({ codeSearchPopup: show });
}

/**
 * What the search windows were showing — kept across their remounts (a tool
 * window remounts whenever it's moved to another dock) and reopenings.
 */
export const searchDrafts = {
  findPattern: "",
  findMode: "find" as FindWindowMode,
  /** The `find.seq` the Find and Replace window last acted on. */
  findSeq: 0,
  /** Code Search's text, its `f:`/`t:`/... prefix included. */
  codeQuery: "",
};
