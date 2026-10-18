/**
 * `.yres` resource files (see docs/yres.md): one Yog Data object of entries
 * in file order, each either a text or `{ "type": ..., "value": ..., ... }`.
 * Read with `parseData`, which keeps integer-like names in place and
 * duplicates as they are — the editor shows both, and reports errors with
 * their line.
 */

import { sep, typed } from "../data/yogIds.generated";
import { classify, DataSyntaxError, escapeAt, parseData, type DataNode } from "../data/yogData";

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
  /** Images: the texture path under `assets/<mod id>/textures/`. */
  texture?: string;
  /** Sounds: the sound event name. */
  event?: string;
  /** Sounds: the subtitle's translation key. */
  subtitle?: string;
  /** 1-based line of the name. */
  line?: number;
}

export type YresParse = { ok: true; entries: YresEntry[] } | { ok: false; error: string; line: number };

/** The neutral file's language. */
export const NEUTRAL_LOCALE = "en_us";

/** The object fields, in the order the serializer writes them. */
const FIELDS = ["type", "value", "comment", "key", "texture", "event", "subtitle"] as const;

class ParseError extends Error {
  constructor(
    message: string,
    readonly line: number
  ) {
    super(message);
  }
}

/** A plain text: `@@` unescaped, any other `@…` an error (as in `yog build`). */
function plainText(node: DataNode & { t: "str" }, what: string): string {
  let typed;
  try {
    typed = classify(node.v);
  } catch (e) {
    throw new ParseError(`${what}: ${(e as Error).message}`, node.line);
  }
  if (typed.t !== "str") throw new ParseError(`${what}: expected plain text, found a reference (write \`@@\` for a literal \`@\`)`, node.line);
  return typed.v;
}

/** A string, number or `true`/`false`. */
function scalar(node: DataNode, what: string): string | number | boolean {
  if (node.t === "str") return plainText(node, what);
  if (node.t === "num" || node.t === "bool") return node.v;
  throw new ParseError(`${what} must be a string, a number or true/false`, node.line);
}

/** Parses `.yres` text, duplicate names kept (the editor flags them; `yog build` rejects them). */
export function parseYres(text: string): YresParse {
  try {
    let root: DataNode;
    try {
      root = parseData(text);
    } catch (e) {
      if (e instanceof DataSyntaxError) throw new ParseError(e.message, e.line);
      throw e;
    }
    if (root.t !== "map") throw new ParseError("expected `{` — a .yres file is one JSON object of resources", root.line);
    const entries: YresEntry[] = [];
    for (const { key: name, keyLine, value } of root.entries) {
      if (name.startsWith("$")) continue;
      if (value.t !== "map") {
        const v = scalar(value, `"${name}"`);
        entries.push({ name, type: defaultType(v), value: v, line: keyLine });
        continue;
      }
      const fields: Record<string, string | number | boolean> = {};
      for (const f of value.entries) {
        if (f.key.startsWith("$") || f.key.startsWith("_")) continue;
        if (!(FIELDS as readonly string[]).includes(f.key))
          throw new ParseError(`"${name}": unknown field \`${f.key}\` (expected ${FIELDS.map((x) => `\`${x}\``).join(", ")})`, f.keyLine);
        if (f.key === "value") fields.value = scalar(f.value, `"${name}": \`value\``);
        else if (f.value.t === "str") fields[f.key] = plainText(f.value, `"${name}": \`${f.key}\``);
        else throw new ParseError(`"${name}": \`${f.key}\` must be a string`, f.value.line);
      }
      if (fields.value === undefined) throw new ParseError(`"${name}": missing \`value\``, keyLine);
      const type = (fields.type ?? defaultType(fields.value)) as string;
      if (!(RESOURCE_TYPES as readonly string[]).includes(type))
        throw new ParseError(`"${name}": unknown type \`${type}\` (expected ${RESOURCE_TYPES.join(", ")})`, keyLine);
      const entry: YresEntry = { name, type: type as ResourceType, value: fields.value, line: keyLine };
      for (const f of ["comment", "key", "texture", "event", "subtitle"] as const) if (typeof fields[f] === "string") entry[f] = fields[f] as string;
      entries.push(entry);
    }
    return { ok: true, entries };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: e.message, line: e.line };
    throw e;
  }
}

function defaultType(value: string | number | boolean): ResourceType {
  return typeof value === "number" ? "number" : typeof value === "boolean" ? "bool" : "string";
}

/** Whether `entry` needs the object form (anything but a plain text). */
function needsObject(e: YresEntry): boolean {
  return e.type !== "string" || typeof e.value !== "string" || !!(e.comment || e.key || e.texture || e.event || e.subtitle);
}

/** `.yres` text for `entries`: 2-space indent, file order, one entry per line, a bare string for a plain text. */
export function serializeYres(entries: YresEntry[]): string {
  if (entries.length === 0) return "{\n}\n";
  /** A value as written: a leading `@` doubled, so text never reads as a reference. */
  const lit = (v: string | number | boolean) => JSON.stringify(typeof v === "string" ? escapeAt(v) : v);
  const lines = entries.map((e) => {
    const name = JSON.stringify(e.name);
    if (!needsObject(e)) return `  ${name}: ${lit(e.value)}`;
    const parts: string[] = [];
    for (const f of FIELDS) {
      if (f === "type") {
        if (e.type !== "string") parts.push(`"type": ${JSON.stringify(e.type)}`);
      } else if (f === "value") parts.push(`"value": ${lit(e.value)}`);
      else if (e[f]) parts.push(`${JSON.stringify(f)}: ${lit(e[f])}`);
    }
    return `  ${name}: { ${parts.join(", ")} }`;
  });
  return `{\n${lines.join(",\n")}\n}\n`;
}

/** Minecraft's locale codes: lower case, `en_us`, `pt_br`, `lol_us`, ... */
export function isLocaleName(name: string): boolean {
  return /^[a-z]{2,3}_[a-z0-9]{2,4}$/.test(name);
}

/** An entry name: identifiers, optionally dotted (`title`, `screen.title`). */
export function isEntryName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(name);
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

/** `screen.title` → `screen_title`, `ModName` → `mod_name` — the generated accessor. */
export function accessorName(name: string): string {
  return name
    .replace(/\./g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/** A text's translation key: its `key`, else by set — `Items` → `item.<mod>.<name>`, ... */
export function translationKey(set: string, entry: Pick<YresEntry, "name" | "key">, modId: string): string {
  if (entry.key) return entry.key;
  const prefix = set === "Items" ? "item." : set === "Blocks" ? "block." : set === "Entities" ? "entity." : "";
  return `${prefix}${modId}.${entry.name}`;
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
