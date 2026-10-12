import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceState } from "./WorkspaceContext";

interface BreakpointsContextValue {
  /** Breakpoints set for `path` — stable empty set when there are none, so callers can pass it straight through as a prop without a fresh identity on every render. */
  forFile: (path: string) => ReadonlySet<number>;
  toggle: (path: string, line: number) => void;
}

const EMPTY: ReadonlySet<number> = new Set();

/** Stored shape: absolute file path → sorted breakpoint lines. */
type StoredBreakpoints = Record<string, number[]>;

function isStoredBreakpoints(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((lines) => Array.isArray(lines) && lines.every((l) => Number.isInteger(l) && l > 0))
  );
}

function keyOf(file: string, line: number): string {
  return `${line}\u0000${file}`;
}

function flatten(stored: StoredBreakpoints): Map<string, { file: string; line: number }> {
  const out = new Map<string, { file: string; line: number }>();
  for (const [file, lines] of Object.entries(stored)) {
    for (const line of lines) out.set(keyOf(file, line), { file, line });
  }
  return out;
}

const BreakpointsContext = createContext<BreakpointsContextValue | null>(null);

/**
 * Owns every breakpoint the user has set, keyed by absolute file path —
 * independent of whether a debug session is currently attached (an IDE
 * lets you set breakpoints before pressing Start, same as the Rust side's
 * own `BREAKPOINTS` mirror, armed the moment attach succeeds — see
 * `Tracer::attach` in `src-tauri/src/debugger.rs`).
 *
 * Remembered per project (`debugger.breakpoints` in the workspace state),
 * so they come back with the project. The Rust side is kept in sync by
 * diffing against what it was last told — toggles, and a whole different
 * set when another project is opened, go through the same path; failures
 * to arm surface in the Output panel.
 */
export function BreakpointsProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useWorkspaceState<StoredBreakpoints>("debugger.breakpoints", {}, isStoredBreakpoints);
  // What the backend currently has — the effect below only sends changes.
  const synced = useRef(new Map<string, { file: string; line: number }>());

  useEffect(() => {
    const wanted = flatten(stored);
    for (const [key, bp] of synced.current) {
      if (!wanted.has(key)) {
        invoke("debug_clear_breakpoint", bp).catch((err) => console.error("clearing breakpoint:", err));
      }
    }
    for (const [key, bp] of wanted) {
      if (!synced.current.has(key)) {
        invoke("debug_set_breakpoint", bp).catch((err) => console.error("setting breakpoint:", err));
      }
    }
    synced.current = wanted;
  }, [stored]);

  const byFile = useMemo(() => {
    const map = new Map<string, ReadonlySet<number>>();
    for (const [file, lines] of Object.entries(stored)) map.set(file, new Set(lines));
    return map;
  }, [stored]);

  const forFile = useCallback((path: string) => byFile.get(path) ?? EMPTY, [byFile]);

  const toggle = useCallback(
    (path: string, line: number) => {
      setStored((prev) => {
        const lines = new Set(prev[path] ?? []);
        if (lines.has(line)) lines.delete(line);
        else lines.add(line);
        const next = { ...prev };
        if (lines.size === 0) delete next[path];
        else next[path] = [...lines].sort((a, b) => a - b);
        return next;
      });
    },
    [setStored],
  );

  const value = useMemo(() => ({ forFile, toggle }), [forFile, toggle]);

  return <BreakpointsContext.Provider value={value}>{children}</BreakpointsContext.Provider>;
}

export function useBreakpoints(): BreakpointsContextValue {
  const ctx = useContext(BreakpointsContext);
  if (!ctx) throw new Error("useBreakpoints must be used within a BreakpointsProvider");
  return ctx;
}
