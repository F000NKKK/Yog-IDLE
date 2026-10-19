import type { Diagnostic, DiagnosticOrigin } from "substrate-platform-ui";
import { program } from "../data/yogIds.generated";

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

/** `path` as printed, relative to `base` unless already absolute. */
export function resolveFrom(base: string, path: string): string {
  return normalizePath(isAbsolute(path) ? path : `${base}/${path}`);
}

/** The Output panel's level tag (`format_log_line`), not part of the tool's own text. */
export function stripLevelTag(line: string): string {
  return line.replace(/^\[(?:warn|error)\] /, "");
}

/** `path:line:`, `path: line N:` or `path:` with a yog source file — the location `yog-cli` prefixes its messages with. */
const LOCATED = /^((?:[A-Za-z]:)?[^:]+\.(?:yui|yres|yblock|yitem|toml|json)):\s*(?:line (\d+):|(\d+):)?\s*(.*)$/;
const ERROR = "yog: error: ";
/** `yog-cli`'s own failures that only summarize what rustc already reported. */
const CARGO_SUMMARY = /^cargo (?:build|check) failed/;

export interface YogParserOptions {
  root: string;
  project?: string;
  origin?: DiagnosticOrigin;
}

/**
 * Reads `yog-cli`'s diagnostics — `.yui`/`.yres`/`.yblock`/`.yitem` and
 * `yog.toml` errors and warnings — out of its output:
 *
 *     yog: error: /p/src/main.yui: line 3: <Button> has no attribute `x`
 *     yog: error: invalid .yres resources:
 *       resources/Strings.yres:12: duplicate name "title"
 *         warning: resources/Colors.yres: …
 *
 * Paths are resolved against the project `root`.
 */
export function createYogParser({ root, project, origin = "build" }: YogParserOptions) {
  let inErrorList = false;

  function diagnostic(severity: Diagnostic["severity"], text: string): Diagnostic | null {
    const m = LOCATED.exec(text);
    if (!m) return null;
    const line = m[2] ?? m[3];
    return {
      severity,
      message: m[4] || text,
      file: resolveFrom(root, m[1]),
      line: line ? Number(line) : undefined,
      project,
      tool: program.CLI,
      origin,
    };
  }

  return {
    push(raw: string): Diagnostic[] {
      const line = stripLevelTag(raw.replace(/\r$/, ""));
      if (line.startsWith(ERROR)) {
        const text = line.slice(ERROR.length);
        inErrorList = text.endsWith(":") && !LOCATED.test(text);
        if (inErrorList || CARGO_SUMMARY.test(text)) return [];
        return [diagnostic("error", text) ?? { severity: "error", message: text, project, tool: program.CLI, origin }];
      }
      const trimmed = line.trimStart();
      if (trimmed.startsWith("warning: ") && line !== trimmed) {
        const d = diagnostic("warning", trimmed.slice("warning: ".length));
        return d ? [d] : [];
      }
      if (inErrorList && line.startsWith("  ")) {
        const d = diagnostic("error", trimmed);
        return d ? [d] : [];
      }
      inErrorList = false;
      return [];
    },
  };
}
