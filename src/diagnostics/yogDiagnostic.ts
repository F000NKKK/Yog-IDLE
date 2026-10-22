// What a Yog tool found (`yog_data::Diagnostic` — the CLI's service
// answers, `yog build`'s records) as the Error List shows it.
import type { Diagnostic, DiagnosticOrigin, DiagnosticSeverity } from "substrate-platform-ui";
import { seg, severity, type Diagnostic as YogDiagnostic, type Seg, type Severity } from "../data/yogDataBinary.generated";

/** A Yog severity's Error List level. */
const LEVEL: Record<Severity, DiagnosticSeverity> = {
  [severity.ERROR]: "error",
  [severity.WARNING]: "warning",
  [severity.NOTE]: "message",
};

/** A key written bare in a path (`entries`), others quoted (`["a b"]`). */
const PLAIN_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A value's path as written: `entries[2].icon`. */
export function pathText(path: readonly Seg[]): string {
  return path
    .map((s, i) => {
      if (s.type === seg.INDEX) return `[${s.value}]`;
      if (!PLAIN_KEY.test(s.value)) return `[${JSON.stringify(s.value)}]`;
      return i > 0 ? `.${s.value}` : s.value;
    })
    .join("");
}

/** `a/b/../c` → `a/c`, either separator; keeps a leading `/` or drive. */
export function normalizePath(path: string): string {
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const parts: string[] = [];
  for (const part of path.split(/[\\/]/)) {
    if (part === "..") {
      if (parts.length > 1 || (parts.length === 1 && parts[0] !== "")) parts.pop();
    } else if (part !== "." && !(part === "" && parts.length > 0)) {
      parts.push(part);
    }
  }
  return parts.join(sep) || sep;
}

const isAbsolute = (path: string) => /^([\\/]|[A-Za-z]:[\\/])/.test(path);

/** `path` relative to `base` unless already absolute. */
export function resolveFrom(base: string, path: string): string {
  return normalizePath(isAbsolute(path) ? path : `${base}/${path}`);
}

/** Where a record goes in the Error List, when it doesn't say itself. */
export interface Place {
  tool: string;
  origin: DiagnosticOrigin;
  /** Its file, when the record doesn't name one. */
  file?: string;
  /** What the record's relative file is relative to: the mod's folder. */
  root?: string;
  project?: string;
}

/** `d` as the Error List shows it. */
export function yogDiagnostic(d: YogDiagnostic, place: Place): Diagnostic {
  const path = d.path && d.path.length > 0 ? `${pathText(d.path)}: ` : "";
  return {
    severity: LEVEL[d.severity],
    origin: place.origin,
    code: d.code,
    message: `${path}${d.message}`,
    tool: d.tool ?? place.tool,
    file: d.file != null && place.root ? resolveFrom(place.root, d.file) : (d.file ?? place.file),
    project: place.project,
    line: d.line,
    column: d.col,
    endLine: d.endLine,
    endColumn: d.endCol,
  };
}
