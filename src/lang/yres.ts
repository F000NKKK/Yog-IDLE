/**
 * `.yres` resource files (see docs/yres.md): one Yog Data object of entries
 * in file order, each either a text or `{ "type": ..., "value": ..., ... }`.
 * Read and written by the CLI service (`yog serve`), never here.
 */

import { cli, ServiceError } from "../toolchain/cli";
import { resKind, serveMethod } from "../data/yogIds.generated";

/** A `.yres` entry's type (yog-ids' `res_kind`). */
export type ResourceType = (typeof resKind)[keyof typeof resKind];
export const RESOURCE_TYPES: readonly ResourceType[] = Object.values(resKind);

export interface YresEntry {
  name: string;
  type: ResourceType;
  value: string | number | boolean;
  /** Design-time note — never shipped. */
  comment?: string;
  /** Texts: the translation key instead of the default one. */
  key?: string;
  /** 1-based line of the name. */
  line?: number;
  /** Read by the CLI: the generated accessor (`screen.title` → `screen_title`). */
  accessor?: string;
  /** Read by the CLI: what's wrong with the name, if anything. */
  nameProblem?: string;
  /** Read by the CLI: what's wrong with the value for its type, if anything. */
  valueProblem?: string;
  /** Read by the CLI: a color's value as ARGB. */
  argb?: number;
  /** Read by the CLI (a text, the set and mod given): its translation key. */
  translationKey?: string;
}

export type YresParse = { ok: true; entries: YresEntry[] } | { ok: false; error: string; line: number };

/** The neutral file's language. */
export const NEUTRAL_LOCALE = "en_us";

/**
 * Parses `.yres` text through the CLI (`yres.parse`), duplicate names kept
 * (the editor flags them; `yog build` rejects them). With the file's `set`
 * and the `mod` id, texts come with their translation keys.
 */
export async function parseYres(text: string, of: { set: string; mod: string } | null = null): Promise<YresParse> {
  try {
    return { ok: true, entries: (await cli<{ entries: YresEntry[] }>(serveMethod.YRES_PARSE, { text, ...(of ?? {}) })).entries };
  } catch (e) {
    if (!(e instanceof ServiceError)) return { ok: false, error: String(e), line: 1 };
    const at = e.problems.find((p) => p.line !== undefined);
    return { ok: false, error: at?.message ?? e.message, line: at?.line ?? 1 };
  }
}

/** `.yres` text for `entries`, written by the CLI (`yres.write`): file order, comments kept. */
export function serializeYres(entries: YresEntry[]): Promise<string> {
  return cli<string>(serveMethod.YRES_WRITE, { entries });
}

/** Minecraft's locale codes: lower case, `en_us`, `pt_br`, `lol_us`, ... */
export function isLocaleName(name: string): boolean {
  return /^[a-z]{2,3}_[a-z0-9]{2,4}$/.test(name);
}

/** `<dir>`, the set, the culture (`null` for the neutral file) and the separator of a `.yres` path. */
export function splitYresPath(path: string): { dir: string; set: string; locale: string | null; sep: string } {
  const sep = path.includes("\\") ? "\\" : "/";
  const cut = path.lastIndexOf(sep);
  const stem = path.slice(cut + 1).replace(/\.yres$/i, "");
  const dot = stem.lastIndexOf(".");
  const tail = dot > 0 ? stem.slice(dot + 1) : "";
  if (tail && isLocaleName(tail)) return { dir: path.slice(0, cut), set: stem.slice(0, dot), locale: tail, sep };
  return { dir: path.slice(0, cut), set: stem, locale: null, sep };
}

/** The file name of `set` in `locale` (`null` = neutral). */
export function yresFileName(set: string, locale: string | null): string {
  return locale ? `${set}.${locale}.yres` : `${set}.yres`;
}

/** A new color's value. */
export const DEFAULT_COLOR = "#FFFFFFFF";

/** A value of `type` converted from `value` (when the type of an entry changes, or from typed text). */
export function coerceValue(type: ResourceType, value: string | number | boolean): string | number | boolean {
  switch (type) {
    case resKind.NUMBER: {
      if (typeof value === "number") return value;
      const n = Number(String(value).trim());
      return String(value).trim() !== "" && Number.isFinite(n) ? n : 0;
    }
    case resKind.BOOL:
      return typeof value === "boolean" ? value : /^(true|1|yes)$/i.test(String(value).trim());
    case resKind.COLOR:
      // Kept as typed: the CLI says whether it's a color (`valueProblem`).
      return typeof value === "string" && value.trim() ? value : DEFAULT_COLOR;
    default:
      return typeof value === "string" ? value : String(value);
  }
}

/** The texts of a parsed `.yres` — `name → value` (the first one for a duplicated name). */
export function textMap(entries: YresEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) if (e.type === "string" && typeof e.value === "string" && !map.has(e.name)) map.set(e.name, e.value);
  return map;
}
