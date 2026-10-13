// The screen designer in the active editor tab, for the tool windows that
// work on it (Toolbox, Document Outline) — they're mounted elsewhere in the
// shell, so the designer publishes itself here.

import { useSyncExternalStore } from "react";
import type { YuiDoc } from "./yui";

export interface ActiveDesigner {
  path: string;
  doc: YuiDoc;
  /** Selected node uids, the primary first. */
  selection: string[];
  select: (uids: string[]) => void;
  /** Adds a new widget — a built-in kind or a component name — where the selection is (Toolbox double-click). */
  addWidget: (kind: string) => void;
  /** Gives the design surface keyboard focus. */
  focus: () => void;
}

let current: ActiveDesigner | null = null;
const subscribers = new Set<() => void>();

export function setActiveDesigner(designer: ActiveDesigner | null): void {
  current = designer;
  subscribers.forEach((notify) => notify());
}

/** Clears it only if `path`'s designer is still the one published. */
export function clearActiveDesigner(path: string): void {
  if (current?.path === path) setActiveDesigner(null);
}

function subscribe(notify: () => void) {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

export function useActiveDesigner(): ActiveDesigner | null {
  return useSyncExternalStore(subscribe, () => current);
}

/** The Toolbox's drag-and-drop payload type (the widget kind or component name). */
export const TOOLBOX_MIME = "application/x-yog-ui-widget";
