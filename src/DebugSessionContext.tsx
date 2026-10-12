import { createContext, useContext, type ReactNode } from "react";
import { useKeybinding } from "substrate-platform-ui";
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

/** Visual Studio's debugger keys, app-wide (capture phase, so the editor doesn't swallow them): F5 Continue, F10/F11/Shift+F11 Step Over/Into/Out, Ctrl+Alt+Break (or Ctrl+Alt+Pause) Break All, Shift+F5 Stop, Ctrl+Shift+F5 Restart. Only active during a debug session. */
function useDebugShortcuts({ debugging, stopped, canRestart, continue_, step, pause, stop, restart }: DebugSessionValue) {
  const paused = !!stopped && stopped.reason !== "exited";
  const bind = (keys: string | string[], id: string, enabled: boolean, run: () => unknown) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useKeybinding(keys, () => void run(), { id, enabled: debugging && enabled });
  bind(["Ctrl+Alt+Pause", "Ctrl+Alt+Cancel"], "debug.breakAll", !paused, pause);
  bind("Ctrl+Shift+F5", "debug.restart", canRestart, restart);
  bind("Shift+F5", "debug.stop", true, stop);
  bind("F5", "debug.continue", paused, continue_);
  bind("F10", "debug.stepOver", paused, () => step("over"));
  bind("Shift+F11", "debug.stepOut", paused, () => step("out"));
  bind("F11", "debug.stepInto", paused, () => step("into"));
}
