import type { MouseEvent as ReactMouseEvent } from "react";

/**
 * A dropdown button's menu position for `useContextMenu().openAtPoint`:
 * just under the button. Opened as a viewport menu — portaled and clamped
 * to the window — so a button at a tool window's right edge never gets its
 * menu clipped by the panel (an anchored menu would be).
 */
export function belowButton(e: ReactMouseEvent<HTMLElement>): MouseEvent {
  const rect = e.currentTarget.getBoundingClientRect();
  return { clientX: rect.left, clientY: rect.bottom + 2, preventDefault() {} } as unknown as MouseEvent;
}
