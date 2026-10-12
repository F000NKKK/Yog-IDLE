import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useDebugSession } from "./useDebugSession";

type DebugSessionValue = ReturnType<typeof useDebugSession>;

const DebugSessionContext = createContext<DebugSessionValue | null>(null);

/** Shares one `useDebugSession` instance across the Debug menu, the toolbar's Restart/Stop section, and `DebugPanel` — all three need the same live state, not independent copies. */
export function DebugSessionProvider({ children }: { children: ReactNode }) {
  const value = useDebugSession();
  useDebugShortcuts(value);
  return <DebugSessionContext.Provider value={value}>{children}</DebugSessionContext.Provider>;
}

export function useDebugSessionContext(): DebugSessionValue {
  const ctx = useContext(DebugSessionContext);
  if (!ctx) throw new Error("useDebugSessionContext must be used within a DebugSessionProvider");
  return ctx;
}

/** Visual Studio's debugger keys, app-wide (capture phase, so the editor doesn't swallow them): F5 Continue, F10/F11/Shift+F11 Step Over/Into/Out, Shift+F5 Stop, Ctrl+Shift+F5 Restart. Only active during a debug session. */
function useDebugShortcuts({ debugging, stopped, canRestart, continue_, step, stop, restart }: DebugSessionValue) {
  useEffect(() => {
    if (!debugging) return;
    const paused = !!stopped && stopped.reason !== "exited";
    const onKeyDown = (e: KeyboardEvent) => {
      let action: (() => unknown) | null = null;
      if (e.key === "F5" && e.shiftKey && e.ctrlKey) action = canRestart ? restart : null;
      else if (e.key === "F5" && e.shiftKey) action = stop;
      else if (e.key === "F5" && !e.ctrlKey && paused) action = continue_;
      else if (e.key === "F10" && !e.shiftKey && paused) action = () => step("over");
      else if (e.key === "F11" && e.shiftKey && paused) action = () => step("out");
      else if (e.key === "F11" && paused) action = () => step("into");
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      action();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [debugging, stopped, canRestart, continue_, step, stop, restart]);
}
