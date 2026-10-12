import { createContext, useContext, type ReactNode } from "react";
import { useKeybinding } from "substrate-platform-ui";
import { useDebugSession } from "./useDebugSession";
import { WatchesProvider } from "./debugger/WatchesContext";

type DebugSessionValue = ReturnType<typeof useDebugSession>;

const DebugSessionContext = createContext<DebugSessionValue | null>(null);

/** Shares one `useDebugSession` instance across the Debug menu, the toolbar's Restart/Stop section, and `DebugPanel` — all three need the same live state, not independent copies. Also holds the Watch list, which the editor adds to. */
export function DebugSessionProvider({ children }: { children: ReactNode }) {
  const value = useDebugSession();
  useDebugShortcuts(value);
  return (
    <DebugSessionContext.Provider value={value}>
      <WatchesProvider>{children}</WatchesProvider>
    </DebugSessionContext.Provider>
  );
}

export function useDebugSessionContext(): DebugSessionValue {
  const ctx = useContext(DebugSessionContext);
  if (!ctx) throw new Error("useDebugSessionContext must be used within a DebugSessionProvider");
  return ctx;
}

/** Visual Studio's debugger keys, app-wide (capture phase, so the editor doesn't swallow them): F5 Continue, F10/F11/Shift+F11 Step Over/Into/Out, Ctrl+Alt+Break (or Ctrl+Alt+Pause) Break All, Shift+F5 Stop, Ctrl+Shift+F5 Restart. Only active during a debug session. */
function useDebugShortcuts({ debugging, stopped, canRestart, continue_, step, pause, stop, restart }: DebugSessionValue) {
  const paused = !!stopped && stopped.reason !== "exited";
  const on = (enabled: boolean) => ({ enabled: debugging && enabled });
  useKeybinding(["Ctrl+Alt+Pause", "Ctrl+Alt+Cancel"], () => void pause(), { id: "debug.breakAll", ...on(!paused) });
  useKeybinding("Ctrl+Shift+F5", () => void restart(), { id: "debug.restart", ...on(canRestart) });
  useKeybinding("Shift+F5", () => void stop(), { id: "debug.stop", ...on(true) });
  useKeybinding("F5", () => void continue_(), { id: "debug.continue", ...on(paused) });
  useKeybinding("F10", () => void step("over"), { id: "debug.stepOver", ...on(paused) });
  useKeybinding("Shift+F11", () => void step("out"), { id: "debug.stepOut", ...on(paused) });
  useKeybinding("F11", () => void step("into"), { id: "debug.stepInto", ...on(paused) });
}
