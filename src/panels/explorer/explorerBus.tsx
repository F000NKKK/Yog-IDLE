import { useEffect, useRef, useSyncExternalStore } from "react";
import { useKeybinding, useShell } from "substrate-platform-ui";
import { boundCommands, keybindingId, type ExplorerCommandId } from "./commands";

// Reaching Project Explorer from outside it: its IDE-wide keybindings live
// here (always mounted — the tool window isn't while it's hidden), and so
// does the request for a second view of the project (New Project Explorer
// View). Module-level, like the other buses: the requester and the window
// are unrelated parts of the dock tree.

/** The Project Explorer tool window's id (declared in `App`). */
export const PROJECT_EXPLORER_PANEL = "projectExplorer";
/** The extra view New Project Explorer View opens (declared in `App`). */
export const PROJECT_EXPLORER_VIEW_PANEL = "projectExplorerView";

/** Commands waiting for the main Project Explorer to (mount and) carry them out. */
const pending: ExplorerCommandId[] = [];
const requestListeners = new Set<() => void>();

function requestExplorerCommand(id: ExplorerCommandId) {
  pending.push(id);
  requestListeners.forEach((notify) => notify());
}

/** The main Project Explorer carries out what's been requested — now, and as requests come. */
export function useExplorerRequests(handle: (id: ExplorerCommandId) => void, enabled: boolean) {
  const ref = useRef(handle);
  ref.current = handle;
  useEffect(() => {
    if (!enabled) return;
    const drain = () => {
      for (let id = pending.shift(); id !== undefined; id = pending.shift()) ref.current(id);
    };
    drain();
    requestListeners.add(drain);
    return () => void requestListeners.delete(drain);
  }, [enabled]);
}

/** Project Explorer's IDE-wide shortcuts (Ctrl+; and the Ctrl+[ chords) — they bring it up first. Renders nothing. */
export function ExplorerKeybindings() {
  const shell = useShell();
  for (const [id, command] of boundCommands(true)) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- a fixed list, the same hooks every render
    useKeybinding(
      command.shortcut,
      () => {
        shell.showToolWindow(PROJECT_EXPLORER_PANEL);
        requestExplorerCommand(id);
      },
      { id: keybindingId(id) }
    );
  }
  return null;
}

/** What the extra view shows: the folder it was opened on; `seq` tells a new request apart. */
export interface ExplorerViewRequest {
  root: string;
  seq: number;
}

let view: ExplorerViewRequest | null = null;
let viewSeq = 0;
const viewListeners = new Set<() => void>();

/** New Project Explorer View: another explorer, scoped to `root`. */
export function openExplorerView(root: string): void {
  view = { root, seq: ++viewSeq };
  viewListeners.forEach((notify) => notify());
}

export function useExplorerView(): ExplorerViewRequest | null {
  return useSyncExternalStore(
    (notify) => {
      viewListeners.add(notify);
      return () => viewListeners.delete(notify);
    },
    () => view
  );
}
