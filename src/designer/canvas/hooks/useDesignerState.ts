// The designer's own state: view settings, error, the session, menus.

import { useRef, useState } from "react";
import { type ContextMenuItem, useContextMenu, useT } from "substrate-platform-ui";
import { useActiveFileTab } from "../../../openFiles/OpenFilesContext";
import type { ScreenDesignerProps } from "../../view/ScreenDesigner";
import { type Session, settings, type ViewSettings } from "../designerModel";

/** The designer's own state: view settings, error, the session, menus. */
export function useDesignerState(props: ScreenDesignerProps) {
  const { path } = props;
  const t = useT();
  const activeTab = useActiveFileTab();
  const isActive = activeTab?.path === path;
  const canvasRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewSettings>(settings);
  const [, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const draggingRef = useRef(false);
  /** The next selection change came from the XAML cursor — don't send the cursor back there. */
  const fromTextRef = useRef(false);
  const menu = useContextMenu();
  /** The menu of a grid rail (Auto / * / pixels, insert, delete). */
  const [railMenu, setRailMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  return { t, activeTab, isActive, canvasRef, view, setView, setRevision, error, setError, sessionRef, draggingRef, fromTextRef, menu, railMenu, setRailMenu };
}

/** What `useDesignerState` gives. */
export type DesignerState = ReturnType<typeof useDesignerState>;
