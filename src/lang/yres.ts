/**
 * `.yres` resource files (see docs/yres.md): one Yog Data object of entries
 * in file order, each either a text or `{ "type": ..., "value": ..., ... }`.
 * Read and written by the CLI service (`yog serve`), never here.
 */

import { sep, typed } from "../data/yogIds.generated";
import { cli } from "../cli";

export const RESOURCE_TYPES = ["string", "image", "file", "sound", "color", "number", "bool"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export interface YresEntry {
  name: string;
  type: ResourceType;
  value: string | number | boolean;
  /** Design-time note — never shipped. */
  comment?: string;
  /** Texts: the translation key instead of the default one. */
  key?: string;
  /** Sounds: the sound event name. */
  event?: string;
  /** Sounds: the subtitle's translation key. */
  subtitle?: string;
  /** 1-based line of the name. */
  line?: number;
  /** Read by the CLI: the generated accessor (`screen.title` → `screen_title`). */
  accessor?: string;
  /** Read by the CLI: what's wrong with the name, if anything. */
  nameProblem?: string;
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
    return { ok: true, entries: (await cli<{ entries: YresEntry[] }>("yres.parse", { text, ...(of ?? {}) })).entries };
  } catch (e) {
    const err = e as { message?: string; line?: number } | string;
    return typeof err === "string" ? { ok: false, error: err, line: 1 } : { ok: false, error: err.message ?? String(e), line: err.line ?? 1 };
  }
}

/** `.yres` text for `entries`, written by the CLI (`yres.write`): file order, comments kept. */
export function serializeYres(entries: YresEntry[]): Promise<string> {
  return cli<string>("yres.write", { entries });
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

/** `#RRGGBB` / `#AARRGGBB`. */
export function isColor(value: string): boolean {
  return /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value);
}

/** Why `entry`'s value doesn't fit its type, or `undefined`. */
/** What bytes are written as: `@bytes:<base64>`. */
const BYTES = `${sep.TYPED}${typed.BYTES}${sep.NAMESPACE}`;

export function valueProblem(entry: YresEntry): string | undefined {
  const v = entry.value;
  switch (entry.type) {
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? undefined : "a number";
    case "bool":
      return typeof v === "boolean" ? undefined : "true or false";
    case "color":
      return typeof v === "string" && isColor(v) ? undefined : "a color, #RRGGBB or #AARRGGBB";
    case "image":
    case "sound":
    case "file":
      return typeof v === "string" && v.startsWith(BYTES) ? undefined : "bytes (@bytes:…)";
    default:
      return typeof v === "string" ? undefined : "a text";
  }
}

/** A value of `type` converted from `value` (when the type of an entry changes, or from typed text). */
export function coerceValue(type: ResourceType, value: string | number | boolean): string | number | boolean {
  switch (type) {
    case "number": {
      if (typeof value === "number") return value;
      const n = Number(String(value).trim());
      return String(value).trim() !== "" && Number.isFinite(n) ? n : 0;
    }
    case "bool":
      return typeof value === "boolean" ? value : /^(true|1|yes)$/i.test(String(value).trim());
    case "color":
      return typeof value === "string" && isColor(value) ? value : "#FFFFFF";
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
