import { useSyncExternalStore } from "react";

// Which search UI is up — opened from keybindings and the Edit menu, shown
// by `SearchHost`. Module-level so the menu needn't reach the host.

export type FindWindowMode = "find" | "replace";

interface SearchUiState {
  /** The Find and Replace window's tab; `seq` changes on every open request, so a second Ctrl+Shift+F re-seeds the field from the editor. */
  findWindow: { mode: FindWindowMode; seq: number } | null;
  codeSearch: { seq: number } | null;
}

let state: SearchUiState = { findWindow: null, codeSearch: null };
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
  set({ findWindow: { mode, seq: ++seq }, codeSearch: null });
}

export function closeFindInFiles(): void {
  set({ findWindow: null });
}

/** Edit > Go To > Code Search (Ctrl+T, Ctrl+,). */
export function openCodeSearch(): void {
  set({ codeSearch: { seq: ++seq } });
}

export function closeCodeSearch(): void {
  set({ codeSearch: null });
}
