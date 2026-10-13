/**
 * `.yres` resource files (see docs/yres.md): one JSON object of entries in
 * file order, each either a text or `{ "type": ..., "value": ..., ... }`.
 * Parsed by hand rather than with `JSON.parse`, which would reorder
 * integer-like names and silently merge duplicates — the editor shows both
 * as they are in the file, and reports errors with their line.
 */

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

/** Parses `.yres` text, duplicate names kept (the editor flags them; `yog build` rejects them). */
export function parseYres(text: string): YresParse {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  const fail = (message: string, at = line): never => {
    throw new ParseError(i >= text.length ? `${message}, found the end of the file` : message, at);
  };
  const ws = () => {
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "\n") line++;
      else if (c !== " " && c !== "\t" && c !== "\r") break;
    }
  };
  const eat = (c: string) => {
    if (text[i] !== c) return false;
    i++;
    return true;
  };
  const string = (): string => {
    if (text[i] !== '"') fail("expected a string");
    const start = i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\n") fail("unterminated string (use \\n for a line break)");
      i += text[i] === "\\" ? 2 : 1;
    }
    if (i >= text.length) fail("unterminated string");
    i++;
    try {
      return JSON.parse(text.slice(start, i)) as string;
    } catch {
      return fail("invalid string escape");
    }
  };
  /** A string, number or `true`/`false`. */
  const scalar = (what: string): string | number | boolean => {
    if (text[i] === '"') return string();
    const m = /^(true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
    if (!m) return fail(`${what} must be a string, a number or true/false`);
    i += m[0].length;
    return m[0] === "true" ? true : m[0] === "false" ? false : Number(m[0]);
  };
  const entryObject = (name: string, keyLine: number): YresEntry => {
    eat("{");
    const fields: Record<string, string | number | boolean> = {};
    ws();
    if (!eat("}")) {
      for (;;) {
        ws();
        const field = string();
        ws();
        if (!eat(":")) fail("expected `:`");
        ws();
        if (!(FIELDS as readonly string[]).includes(field))
          fail(`"${name}": unknown field \`${field}\` (expected ${FIELDS.map((f) => `\`${f}\``).join(", ")})`);
        const v = field === "value" ? scalar(`"${name}": \`value\``) : text[i] === '"' ? string() : fail(`"${name}": \`${field}\` must be a string`);
        fields[field] = v;
        ws();
        if (eat(",")) continue;
        if (eat("}")) break;
        fail("expected `,` or `}`");
      }
    }
    if (fields.value === undefined) fail(`"${name}": missing \`value\``, keyLine);
    const type = (fields.type ?? defaultType(fields.value)) as string;
    if (!(RESOURCE_TYPES as readonly string[]).includes(type))
      fail(`"${name}": unknown type \`${type}\` (expected ${RESOURCE_TYPES.join(", ")})`, keyLine);
    const entry: YresEntry = { name, type: type as ResourceType, value: fields.value, line: keyLine };
    for (const f of ["comment", "key", "texture", "event", "subtitle"] as const) if (typeof fields[f] === "string") entry[f] = fields[f] as string;
    return entry;
  };

  try {
    ws();
    if (!eat("{")) fail("expected `{` — a .yres file is one JSON object of resources");
    const entries: YresEntry[] = [];
    ws();
    if (!eat("}")) {
      for (;;) {
        ws();
        const keyLine = line;
        const name = string();
        ws();
        if (!eat(":")) fail("expected `:` after the name");
        ws();
        if (text[i] === "{") entries.push(entryObject(name, keyLine));
        else {
          const value = scalar(`"${name}"`);
          entries.push({ name, type: defaultType(value), value, line: keyLine });
        }
        ws();
        if (eat(",")) continue;
        if (eat("}")) break;
        fail("expected `,` or `}`");
      }
    }
    ws();
    if (i < text.length) fail("unexpected text after the closing `}`");
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
  const lines = entries.map((e) => {
    const name = JSON.stringify(e.name);
    if (!needsObject(e)) return `  ${name}: ${JSON.stringify(e.value)}`;
    const parts: string[] = [];
    for (const f of FIELDS) {
      if (f === "type") {
        if (e.type !== "string") parts.push(`"type": ${JSON.stringify(e.type)}`);
      } else if (f === "value") parts.push(`"value": ${JSON.stringify(e.value)}`);
      else if (e[f]) parts.push(`${JSON.stringify(f)}: ${JSON.stringify(e[f])}`);
    }
    return `  ${name}: { ${parts.join(", ")} }`;
  });
  return `{\n${lines.join(",\n")}\n}\n`;
}

/** Minecraft's locale codes: lower case, `en_us`, `pt_br`, `lol_us`, ... */
export function isLocaleName(name: string): boolean {
  return /^[a-z]{2,3}_[a-z0-9]{2,4}$/.test(name);
}

/** A resource set's name: `Strings`, `Icons`, `MenuTexts`. */
export function isSetName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
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
      return typeof v === "string" && /\.png$/i.test(v) ? undefined : "a .png path";
    case "sound":
      return typeof v === "string" && /\.ogg$/i.test(v) ? undefined : "an .ogg path";
    case "file":
      return typeof v === "string" && v.trim() !== "" ? undefined : "a file path";
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
