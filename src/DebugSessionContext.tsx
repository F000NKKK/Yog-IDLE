import { createContext, useContext, type ReactNode } from "react";
import { useDebugSession } from "./useDebugSession";

type DebugSessionValue = ReturnType<typeof useDebugSession>;

const DebugSessionContext = createContext<DebugSessionValue | null>(null);

/** Shares one `useDebugSession` instance across the Debug menu, the toolbar's Restart/Stop section, and `DebugPanel` — all three need the same live state, not independent copies. */
export function DebugSessionProvider({ children }: { children: ReactNode }) {
  const value = useDebugSession();
  return <DebugSessionContext.Provider value={value}>{children}</DebugSessionContext.Provider>;
}

export function useDebugSessionContext(): DebugSessionValue {
  const ctx = useContext(DebugSessionContext);
  if (!ctx) throw new Error("useDebugSessionContext must be used within a DebugSessionProvider");
  return ctx;
}
