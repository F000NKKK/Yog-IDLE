import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useWorkspaceState } from "../WorkspaceContext";

interface WatchesValue {
  /** Watch expressions, in display order — remembered per project. */
  watches: string[];
  add(expr: string): void;
  /** Replaces watch `index`; an empty `expr` removes it. */
  edit(index: number, expr: string): void;
  remove(index: number): void;
}

const WatchesContext = createContext<WatchesValue | null>(null);

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Visual Studio's Watch list — shared by the Debug panel and the editor's "Add Watch". */
export function WatchesProvider({ children }: { children: ReactNode }) {
  const [watches, setWatches] = useWorkspaceState<string[]>("debugger.watches", [], isStringArray);
  const value = useMemo<WatchesValue>(
    () => ({
      watches,
      add: (expr) => {
        const e = expr.trim();
        if (e) setWatches((w) => [...w, e]);
      },
      edit: (index, expr) => {
        const e = expr.trim();
        setWatches((w) => (e ? w.map((x, i) => (i === index ? e : x)) : w.filter((_, i) => i !== index)));
      },
      remove: (index) => setWatches((w) => w.filter((_, i) => i !== index)),
    }),
    [watches, setWatches],
  );
  return <WatchesContext.Provider value={value}>{children}</WatchesContext.Provider>;
}

export function useWatches(): WatchesValue {
  const ctx = useContext(WatchesContext);
  if (!ctx) throw new Error("useWatches must be used within a WatchesProvider");
  return ctx;
}
