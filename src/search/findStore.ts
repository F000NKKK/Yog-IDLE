import { useSyncExternalStore } from "react";
import { Channel } from "@tauri-apps/api/core";
import { yog } from "../plugins.generated";
import { invokeCommand } from "substrate-platform-ui";

// Find Results' contents — module-level, like the Output buffers: a search
// is started from the Find and Replace window and shown by the Find Results
// tool window, two unrelated parts of the dock tree, and keeps streaming in
// while either is closed.

export type LookIn = "current" | "open" | "project";

export interface FindQuery {
  pattern: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  fileMask: string;
  /** Also search generated code (`.yog-build/generated/`, screens' `.g.rs`). */
  includeGenerated?: boolean;
}

/** An open editor's buffer, searched instead of its file on disk. */
export interface OpenDocument {
  path: string;
  text: string;
}

export interface FindHit {
  line: number;
  column: number;
  text: string;
  ranges: [number, number][];
}

export interface FileResult {
  path: string;
  relPath: string;
  hits: FindHit[];
}

export interface FindSummary {
  matchingLines: number;
  matchingFiles: number;
  filesSearched: number;
  truncated: boolean;
  cancelled: boolean;
}

export interface ReplaceSummary {
  documents: { path: string; text: string; count: number }[];
  files: { path: string; count: number }[];
  total: number;
  errors: string[];
}

export interface FindResultsState {
  /** What was searched for, as the panel's caption shows it. */
  caption: string;
  files: FileResult[];
  running: boolean;
  summary: FindSummary | null;
  /** Set after a Replace All: per-file counts instead of hits. */
  replaced: { path: string; relPath: string; count: number }[] | null;
  replacedTotal: number;
  error: string | null;
}

const EMPTY: FindResultsState = { caption: "", files: [], running: false, summary: null, replaced: null, replacedTotal: 0, error: null };

let state: FindResultsState = EMPTY;
const subscribers = new Set<() => void>();
let nextSearchId = 1;
let currentSearch = 0;

function set(next: Partial<FindResultsState>) {
  state = { ...state, ...next };
  subscribers.forEach((notify) => notify());
}

export function useFindResults(): FindResultsState {
  return useSyncExternalStore(
    (notify) => {
      subscribers.add(notify);
      return () => subscribers.delete(notify);
    },
    () => state,
  );
}

export function clearFindResults(): void {
  cancelFind();
  set(EMPTY);
}

/** Stops the running search; what it found so far stays listed. */
export function cancelFind(): void {
  if (state.running) void invokeCommand(yog.code.findCancel);
}

interface FindBatch {
  files: FileResult[];
}

/** Find All: replaces Find Results' contents with a new search, streaming files in as they're found. */
export async function runFind(options: { caption: string; root: string | null; lookIn: LookIn; query: FindQuery; documents: OpenDocument[] }): Promise<void> {
  const searchId = nextSearchId++;
  currentSearch = searchId;
  set({ ...EMPTY, caption: options.caption, running: true });
  const onBatch = new Channel<FindBatch>();
  onBatch.onmessage = (batch) => {
    if (currentSearch === searchId) set({ files: [...state.files, ...batch.files] });
  };
  try {
    const summary = await invokeCommand<FindSummary>(yog.code.findInFiles, {
      request: {
        searchId,
        root: options.root,
        scope: options.lookIn === "project" ? "project" : "documents",
        query: options.query,
        documents: options.documents,
      },
      onBatch,
    });
    // Channel messages are delivered in order, but may still be in flight
    // when the command resolves.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (currentSearch === searchId) set({ running: false, summary });
  } catch (err) {
    if (currentSearch === searchId) set({ running: false, error: String(err) });
  }
}

function relativeTo(root: string | null, path: string): string {
  if (root && path.startsWith(root)) return path.slice(root.length).replace(/^[/\\]+/, "").replace(/\\/g, "/");
  return path;
}

/** Shows a Replace All's outcome in Find Results. */
export function showReplaceResults(caption: string, root: string | null, summary: ReplaceSummary): void {
  currentSearch = 0;
  const replaced = [...summary.documents, ...summary.files]
    .map((f) => ({ path: f.path, relPath: relativeTo(root, f.path), count: f.count }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
  set({ ...EMPTY, caption, replaced, replacedTotal: summary.total, error: summary.errors.length ? summary.errors.join("\n") : null });
}
