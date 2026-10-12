import { invoke } from "@tauri-apps/api/core";

/** One value row — a local, a watch result or a member of either — as the backend (debugger.rs `VariableOut`) returns it. */
export interface Variable {
  name: string;
  typeName: string;
  value: string;
  /** Members already known. Empty for a value expanded lazily through `handle`. */
  children: Variable[];
  /** An expression that evaluates back to this row — what "Add Watch" adds. */
  expr?: string;
  /** Set when the members can be fetched (`fetchChildren`) — valid until the debuggee resumes. */
  handle?: number | null;
}

/** One watch expression's result: a value, or why there isn't one. */
export interface WatchResult {
  value: Variable | null;
  error: string | null;
}

export function canExpand(v: Variable): boolean {
  return v.children.length > 0 || v.handle != null;
}

/** The selected frame's locals; `frame` is the stack frame's id. */
export function fetchLocals(frame: number): Promise<Variable[]> {
  return invoke<Variable[]>("debug_variables", { frame });
}

/** The members of an expandable value (`handle`) at the current stop. */
export function fetchChildren(handle: number): Promise<Variable[]> {
  return invoke<Variable[]>("debug_children", { handle });
}

/** Evaluates watch expressions in a frame. A failure of the request itself becomes every expression's error. */
export async function evaluate(frame: number, exprs: string[]): Promise<WatchResult[]> {
  if (exprs.length === 0) return [];
  try {
    return await invoke<WatchResult[]>("debug_evaluate", { frame, exprs });
  } catch (err) {
    return exprs.map(() => ({ value: null, error: String(err) }));
  }
}

const KEYWORDS = new Set(
  "as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return Self static struct super trait true type unsafe use where while async await dyn".split(" "),
);

/** Rust identifiers in `text`, in order of appearance, without keywords and duplicates. */
export function identifiers(text: string): string[] {
  const seen = new Set<string>();
  // Skip string literals and line comments, roughly.
  const code = text.replace(/"(?:\\.|[^"\\])*"/g, " ").replace(/\/\/.*$/, "");
  for (const m of code.matchAll(/(?<![\w.:])[A-Za-z_][A-Za-z0-9_]*/g)) {
    if (!KEYWORDS.has(m[0])) seen.add(m[0]);
  }
  return [...seen];
}

/**
 * The expression a DataTip shows for the point `column` in `line`: the
 * identifier there plus the member path leading to it (`a.b.c` hovered at
 * `b` gives `a.b`, like Visual Studio). `null` over anything else.
 */
export function expressionAt(line: string, column: number): { expr: string; from: number; to: number } | null {
  const word = /[A-Za-z0-9_]/;
  let start = column;
  let end = column;
  while (start > 0 && word.test(line[start - 1])) start--;
  while (end < line.length && word.test(line[end])) end++;
  if (start === end) return null;
  const hovered = line.slice(start, end);
  if (/^[0-9]/.test(hovered) && !(start > 0 && line[start - 1] === ".")) return null;
  if (KEYWORDS.has(hovered) && hovered !== "self") return null;
  // A call or macro isn't a value.
  if (/^\s*(?:\(|!(?!=))/.test(line.slice(end))) return null;
  // Walk back over `.member` and `path::` segments.
  let from = start;
  for (;;) {
    const before = line.slice(0, from);
    const m = /(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+)(?:\.|::)$/.exec(before);
    if (!m) break;
    from -= m[0].length;
  }
  if (/^[0-9]/.test(line.slice(from))) return null;
  return { expr: line.slice(from, end), from, to: end };
}
