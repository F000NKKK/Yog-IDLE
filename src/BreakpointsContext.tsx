import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

interface BreakpointsContextValue {
  /** Breakpoints set for `path` — stable empty set when there are none, so callers can pass it straight through as a prop without a fresh identity on every render. */
  forFile: (path: string) => ReadonlySet<number>;
  toggle: (path: string, line: number) => void;
}

const EMPTY: ReadonlySet<number> = new Set();

const BreakpointsContext = createContext<BreakpointsContextValue | null>(null);

/**
 * Owns every breakpoint the user has set, keyed by absolute file path —
 * independent of whether a debug session is currently attached (an IDE
 * lets you set breakpoints before pressing Start, same as `debug_start`'s
 * "pending breakpoints" list on the Rust side handles). Toggling always
 * calls through to `debug_set_breakpoint`/`debug_clear_breakpoint`, which
 * itself decides whether to arm it immediately (session live) or just
 * remember it for later (no session yet).
 */
export function BreakpointsProvider({ children }: { children: ReactNode }) {
  const [byFile, setByFile] = useState<Map<string, Set<number>>>(new Map());

  const forFile = useCallback((path: string) => byFile.get(path) ?? EMPTY, [byFile]);

  const toggle = useCallback((path: string, line: number) => {
    setByFile((prev) => {
      const next = new Map(prev);
      const lines = new Set(next.get(path) ?? []);
      if (lines.has(line)) {
        lines.delete(line);
        invoke("debug_clear_breakpoint", { file: path, line }).catch((err) => console.error("clearing breakpoint:", err));
      } else {
        lines.add(line);
        invoke("debug_set_breakpoint", { file: path, line }).catch((err) => console.error("setting breakpoint:", err));
      }
      next.set(path, lines);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ forFile, toggle }), [forFile, toggle]);

  return <BreakpointsContext.Provider value={value}>{children}</BreakpointsContext.Provider>;
}

export function useBreakpoints(): BreakpointsContextValue {
  const ctx = useContext(BreakpointsContext);
  if (!ctx) throw new Error("useBreakpoints must be used within a BreakpointsProvider");
  return ctx;
}
