/**
 * Yog Data's text syntax (the Rust crate `yog-data`, module `text`): JSON
 * plus `//` and `/* *\/` comments, trailing commas and unquoted keys — the
 * one syntax of every Yog format. Parsed into a tree that keeps where every
 * value and key is, for the editors' diagnostics and selection sync.
 *
 * Unlike the build, duplicate keys are kept (in file order): the editors
 * show both and flag them, `yog build` rejects them.
 */

interface At {
  /** UTF-16 offsets, like CodeMirror's. */
  start: number;
  end: number;
  /** 1-based. */
  line: number;
}

export type DataNode =
  | ({ t: "null" } & At)
  | ({ t: "bool"; v: boolean } & At)
  | ({ t: "num"; v: number; int: boolean } & At)
  | ({ t: "str"; v: string } & At)
  | ({ t: "list"; items: DataNode[] } & At)
  | ({ t: "map"; entries: DataEntry[] } & At);

export interface DataEntry {
  key: string;
  keyStart: number;
  keyLine: number;
  value: DataNode;
}

export class DataSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
    readonly line: number,
    readonly col: number
  ) {
    super(message);
  }
}

/** Deeper than this is an error. */
export const MAX_DEPTH = 256;

/** Parses Yog Data text; throws `DataSyntaxError`. */
export function parseData(text: string): DataNode {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let depth = 0;
  const fail = (message: string, at = i): never => {
    let l = 1;
    let ls = 0;
    for (let k = 0; k < at && k < text.length; k++) {
      if (text.charCodeAt(k) === 10) {
        l++;
        ls = k + 1;
      }
    }
    throw new DataSyntaxError(at >= text.length ? `${message}, found the end of the file` : message, at, l, at - ls + 1);
  };
  const ws = () => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 10) {
        line++;
        i++;
      } else if (c === 32 || c === 9 || c === 13) i++;
      else if (c === 47 && text.charCodeAt(i + 1) === 47) {
        while (i < text.length && text.charCodeAt(i) !== 10) i++;
      } else if (c === 47 && text.charCodeAt(i + 1) === 42) {
        const end = text.indexOf("*/", i + 2);
        if (end < 0) fail("unclosed `/*` comment");
        for (let k = i; k < end; k++) if (text.charCodeAt(k) === 10) line++;
        i = end + 2;
      } else return;
    }
  };
  const string = (): string => {
    const open = i++;
    let out = "";
    let run = i;
    for (;;) {
      if (i >= text.length) fail("unclosed string", open);
      const c = text.charCodeAt(i);
      if (c === 34) {
        out += text.slice(run, i);
        i++;
        return out;
      }
      if (c === 92) {
        out += text.slice(run, i);
        const at = i;
        const e = text[i + 1];
        i += 2;
        const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (e !== undefined && e in simple) out += simple[e];
        else if (e === "u") {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("`\\u` needs four hex digits", at);
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else fail("unknown escape (`\\n`, `\\t`, `\\\"`, `\\\\`, `\\uXXXX`, ...)", at);
        run = i;
        continue;
      }
      if (c === 10) fail("line break in a string (write `\\n`)");
      if (c < 32) fail("control character in a string");
      i++;
    }
  };
  const value = (): DataNode => {
    const start = i;
    const at = { start, line };
    const c = text[i];
    if (c === "{" || c === "[") {
      if (++depth > MAX_DEPTH) fail(`nested deeper than ${MAX_DEPTH} levels`);
      const node = c === "{" ? map(at) : list(at);
      depth--;
      return node;
    }
    if (c === '"') {
      const v = string();
      return { t: "str", v, start, end: i, line: at.line };
    }
    if (c === "'") fail("strings use double quotes");
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (m && m[0] !== "-") {
      if (/^-?0\d/.test(text.slice(i, i + 3))) fail("numbers don't start with 0");
      i += m[0].length;
      return { t: "num", v: Number(m[0]), int: !m[2] && !m[3], start, end: i, line: at.line };
    }
    for (const [word, node] of [
      ["true", { t: "bool", v: true }],
      ["false", { t: "bool", v: false }],
      ["null", { t: "null" }],
    ] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return { ...node, start, end: i, line: at.line } as DataNode;
      }
    }
    return fail("expected a value");
  };
  const list = (at: { start: number; line: number }): DataNode => {
    i++;
    const items: DataNode[] = [];
    for (;;) {
      ws();
      if (text[i] === "]") {
        i++;
        break;
      }
      items.push(value());
      ws();
      if (text[i] === ",") i++;
      else if (text[i] === "]") {
        i++;
        break;
      } else fail("expected `,` or `]`");
    }
    return { t: "list", items, start: at.start, end: i, line: at.line };
  };
  const map = (at: { start: number; line: number }): DataNode => {
    i++;
    const entries: DataEntry[] = [];
    for (;;) {
      ws();
      if (text[i] === "}") {
        i++;
        break;
      }
      const keyStart = i;
      const keyLine = line;
      let key: string;
      if (text[i] === '"') key = string();
      else {
        const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i, i + 256));
        if (!m) return fail("expected a key");
        key = m[0];
        i += key.length;
      }
      ws();
      if (text[i] !== ":") fail("expected `:` after the key");
      i++;
      ws();
      entries.push({ key, keyStart, keyLine, value: value() });
      ws();
      if (text[i] === ",") i++;
      else if (text[i] === "}") {
        i++;
        break;
      } else fail("expected `,` or `}`");
    }
    return { t: "map", entries, start: at.start, end: i, line: at.line };
  };

  ws();
  const root = value();
  ws();
  if (i < text.length) fail("unexpected text after the value");
  return root;
}

/** Source-only keys every object may have: `$…`, `_…`, `comment`. */
export function isMetadataKey(key: string): boolean {
  return key.startsWith("$") || key.startsWith("_") || key === "comment";
}

/** A typed value's string form, read (see the Rust `yog_data::typed`). */
export type Typed =
  | { t: "str"; v: string }
  | { t: "ref"; kind: string; id: string }
  | { t: "tag"; kind: string; id: string }
  | { t: "res"; set: string; key: string }
  | { t: "image"; source: string }
  | { t: "lang"; key: string };

const KIND = /^[a-z][a-z0-9_]*$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A content id, `minecraft:` by default, with an optional `[state]`/`{nbt}` — `null` if it isn't one. */
export function resourceId(id: string): string | null {
  const cut = id.search(/[[{]/);
  const base = cut < 0 ? id : id.slice(0, cut);
  const suffix = cut < 0 ? "" : id.slice(cut);
  const [ns, path] = base.includes(":") ? [base.slice(0, base.indexOf(":")), base.slice(base.indexOf(":") + 1)] : ["minecraft", base];
  if (!/^[a-z0-9_.-]+$/.test(ns) || !/^[a-z0-9_./-]+$/.test(path)) return null;
  if (suffix && !/[\]}]$/.test(suffix)) return null;
  return `${ns}:${path}${suffix}`;
}

/** `s` as a typed value (`@item:minecraft:stick`, `@tag:…`, `@Set.key`, `@image:…`, `@lang:…`) or plain text; `@@` escapes. Throws on a malformed `@…`. */
export function classify(s: string): Typed {
  if (!s.startsWith("@")) return { t: "str", v: s };
  const rest = s.slice(1);
  if (rest.startsWith("@")) return { t: "str", v: rest };
  const cut = rest.search(/[:.]/);
  if (cut < 0) throw new Error(`\`${s}\`: a reference is \`@kind:id\` (\`@item:minecraft:stick\`) or \`@Set.key\`; write \`@@\` for a literal \`@\``);
  const head = rest.slice(0, cut);
  const tail = rest.slice(cut + 1);
  if (rest[cut] === ".") {
    if (!IDENT.test(head) || !/^[A-Z]/.test(head)) throw new Error(`\`${s}\`: a resource is \`@Set.key\` with an upper-case set name (\`@Strings.title\`)`);
    if (!tail || !tail.split(".").every((p) => IDENT.test(p))) throw new Error(`\`${s}\`: \`${tail}\` isn't a resource key (letters, digits, \`_\`, dotted)`);
    return { t: "res", set: head, key: tail };
  }
  if (!KIND.test(head)) throw new Error(`\`${s}\`: \`${head}\` isn't a kind of content (lower case: \`item\`, \`block\`, \`tag\`, ...)`);
  if (head === "lang") {
    if (!/^[A-Za-z0-9_.:/-]+$/.test(tail)) throw new Error(`\`${s}\`: \`@lang:\` takes a translation key as the lang files have it (\`@lang:gui.done\`)`);
    return { t: "lang", key: tail };
  }
  if (head === "image") {
    if (!tail) throw new Error(`\`${s}\`: no image source after \`@image:\``);
    return { t: "image", source: tail };
  }
  if (head === "tag") {
    const c = tail.indexOf(":");
    const kind = c < 0 ? "" : tail.slice(0, c);
    if (!KIND.test(kind)) throw new Error(`\`${s}\`: a tag is \`@tag:kind:id\` (\`@tag:item:minecraft:planks\`)`);
    const id = resourceId(tail.slice(c + 1));
    if (!id) throw new Error(`\`${s}\`: \`${tail.slice(c + 1)}\` isn't an id (lower case \`namespace:path\`)`);
    return { t: "tag", kind, id };
  }
  const id = resourceId(tail);
  if (!id) throw new Error(`\`${s}\`: \`${tail}\` isn't an id (lower case \`namespace:path\`)`);
  return { t: "ref", kind: head, id };
}

/** `s` with a leading `@` doubled, so it reads back as plain text. */
export function escapeAt(s: string): string {
  return s.startsWith("@") ? `@${s}` : s;
}

/** `node` as a plain JS value (maps as objects; a duplicated key's last value). */
export function toPlain(node: DataNode): unknown {
  switch (node.t) {
    case "null":
      return null;
    case "list":
      return node.items.map(toPlain);
    case "map":
      return Object.fromEntries(node.entries.map((e) => [e.key, toPlain(e.value)]));
    default:
      return node.v;
  }
}

/**
 * `node` as a JS value with its maps as `Map`s, in file order — for a map
 * whose keys JS objects would reorder (times: `"0"`, `"0.25"`, `"1"`).
 * `patchDataText` and `formatData` take `Map`s as maps.
 */
export function toOrdered(node: DataNode): unknown {
  switch (node.t) {
    case "null":
      return null;
    case "list":
      return node.items.map(toOrdered);
    case "map":
      return new Map(node.entries.map((e) => [e.key, toOrdered(e.value)]));
    default:
      return node.v;
  }
}

/** A map's entries — a `Map`'s in its order, an object's as JS orders them. */
export const entriesOf = (v: object): [string, unknown][] => (v instanceof Map ? [...v.entries()] : Object.entries(v));

/** Parses Yog Data text to a plain JS value, like `JSON.parse` for the wider syntax; throws `DataSyntaxError`. */
export function parseDataValue(text: string): unknown {
  return toPlain(parseData(text));
}

// ── Editing text in place ────────────────────────────────────────────────────

/** How a new or changed value is written: `level` is its line's indent (in steps of two spaces). */
export type DataFormat = (value: unknown, level: number) => string;

/**
 * A value as Yog's editors write it at indent `level` (two spaces each):
 * short lists of numbers and short objects of scalars on one line
 * (`"uv": [0, 0, 16, 16]`), the rest one entry a line — what
 * `patchDataText` writes a changed value with.
 */
export const formatData: DataFormat = (value, level) => {
  const round = (n: number) => Math.round(n * 10000) / 10000;
  const scalar = (v: unknown): string | null => {
    if (v === null) return "null";
    if (typeof v === "number") return String(round(v));
    if (typeof v === "boolean") return String(v);
    if (typeof v === "string") return JSON.stringify(v);
    return null;
  };
  const inline = (v: unknown): string | null => {
    const s = scalar(v);
    if (s !== null) return s;
    let out: string;
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      if (!v.every((x) => typeof x === "number" || typeof x === "boolean")) return null;
      out = `[${v.map((x) => scalar(x)).join(", ")}]`;
    } else if (v && typeof v === "object") {
      const entries = entriesOf(v).filter(([, x]) => x !== undefined);
      if (entries.length === 0) return "{}";
      const parts: string[] = [];
      for (const [k, x] of entries) {
        if (isObject(x)) return null;
        const s2 = inline(x);
        if (s2 === null) return null;
        parts.push(`${JSON.stringify(k)}: ${s2}`);
      }
      out = `{ ${parts.join(", ")} }`;
    } else return null;
    return out.length <= 72 ? out : null;
  };
  const write = (v: unknown, indent: number): string => {
    const one = inline(v);
    if (one !== null) return one;
    const pad = "  ".repeat(indent + 1);
    const end = "  ".repeat(indent);
    if (Array.isArray(v)) return `[\n${v.map((x) => pad + write(x, indent + 1)).join(",\n")}\n${end}]`;
    const entries = entriesOf(v as object).filter(([, x]) => x !== undefined);
    return `{\n${entries.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${write(x, indent + 1)}`).join(",\n")}\n${end}}`;
  };
  return write(value, level);
};

function isObject(v: unknown): v is Record<string, unknown> | Map<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
const plainMaps = (_: string, v: unknown) => (v instanceof Map ? Object.fromEntries(v) : v);
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a, plainMaps) === JSON.stringify(b, plainMaps);

/**
 * `text` (Yog Data) changed to hold `next`, the rest of it as it was: what
 * didn't change keeps its text — comments, key order, number spelling,
 * layout — and what did is written by `format` at its place's indent. Maps
 * and lists are edited entry by entry (a kept entry keeps the comments
 * before it; a removed one takes them along). Text that doesn't parse is
 * written anew.
 */
export function patchDataText(text: string, next: unknown, format: DataFormat): string {
  let root: DataNode;
  try {
    root = parseData(text);
  } catch {
    return `${format(next, 0)}\n`;
  }
  return text.slice(0, root.start) + rewrite(text, root, next, format) + text.slice(root.end);
}

/** The indent of the line `at` is on: its leading whitespace. */
function lineIndent(text: string, at: number): string {
  const start = text.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start, at))![0];
}

const levelOf = (indent: string) => Math.round(indent.replace(/\t/g, "  ").length / 2);

/** Past the key at `i` (quoted or bare). */
function skipKey(text: string, i: number): number {
  if (text[i] !== '"') return i + /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i, i + 256))![0].length;
  for (i++; text[i] !== '"'; i++) if (text[i] === "\\") i++;
  return i + 1;
}

/** Past whitespace and comments from `i`. */
function skipBlank(text: string, i: number): number {
  for (;;) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) i++;
    else if (c === 47 && text.charCodeAt(i + 1) === 47) {
      while (i < text.length && text.charCodeAt(i) !== 10) i++;
    } else if (c === 47 && text.charCodeAt(i + 1) === 42) i = text.indexOf("*/", i + 2) + 2;
    else return i;
  }
}

/** The new text of `node` (its own range) holding `next`. */
function rewrite(text: string, node: DataNode, next: unknown, format: DataFormat): string {
  if (sameValue(toPlain(node), next)) return text.slice(node.start, node.end);
  const level = levelOf(lineIndent(text, node.start));
  const oneLine = !text.slice(node.start, node.end).includes("\n");
  const fresh = () => format(next, level);
  if (oneLine) return fresh();
  if (node.t === "map" && isObject(next)) {
    const keys = node.entries.map((e) => e.key);
    if (new Set(keys).size !== keys.length || !node.entries.length) return fresh();
    const parts = members(text, node, node.entries.map((e) => ({ start: e.keyStart, end: e.value.end })));
    const pad = lineIndent(text, node.entries[0].keyStart);
    const out: Member[] = [];
    const has = new Map(entriesOf(next).filter(([, v]) => v !== undefined));
    const gone = (i: number) => i < keys.length && !has.has(keys[i]);
    // The old entry last written: a new key right after it, in the place of one that's gone, is that one renamed.
    let last = -1;
    for (const [k, v] of has) {
      let i = keys.indexOf(k);
      const renamed = i < 0 && gone(last + 1);
      if (renamed) i = last + 1;
      if (i < 0) {
        out.push({ body: `\n${pad}${JSON.stringify(k)}: ${format(v, levelOf(pad))}`, trail: "" });
        continue;
      }
      last = i;
      const e = node.entries[i];
      const seg = parts.segments[i];
      const key = renamed ? `${JSON.stringify(k)}${text.slice(skipKey(text, e.keyStart), e.value.start)}` : text.slice(e.keyStart, e.value.start);
      out.push({ body: seg.lead + key + rewrite(text, e.value, v, format), trail: seg.trail });
    }
    return `{${joinMembers(out, parts.comma)}${parts.tail}}`;
  }
  if (node.t === "list" && Array.isArray(next)) {
    if (!node.items.length) return fresh();
    const parts = members(text, node, node.items);
    const pad = lineIndent(text, node.items[0].start);
    const old = node.items.map(toPlain);
    const out: Member[] = [];
    const item = (i: number, v: unknown): Member => ({ body: parts.segments[i].lead + rewrite(text, node.items[i], v, format), trail: parts.segments[i].trail });
    if (next.length === old.length) next.forEach((v, i) => out.push(item(i, v)));
    else {
      // Added or removed items: the others keep their text.
      let from = 0;
      for (const v of next) {
        const i = old.findIndex((o, k) => k >= from && sameValue(o, v));
        if (i >= 0) {
          out.push(item(i, v));
          from = i + 1;
        } else out.push({ body: `\n${pad}${format(v, levelOf(pad))}`, trail: "" });
      }
    }
    return `[${joinMembers(out, parts.comma)}${parts.tail}]`;
  }
  return fresh();
}

/** A member as rewritten: its text, then what followed it (a comment) — the comma goes between. */
interface Member {
  body: string;
  trail: string;
}

const joinMembers = (out: Member[], trailingComma: boolean) =>
  out.map((m, i) => m.body + (i < out.length - 1 || trailingComma ? "," : "") + m.trail).join("");

/**
 * A map's or list's members as text: each one's `lead` (from the separator
 * before it — the comments above it) and `trail` (after it, up to its
 * comma); whether the last has a comma; what's left before the bracket.
 */
function members(text: string, node: DataNode, spans: { start: number; end: number }[]) {
  const segments: { lead: string; trail: string }[] = [];
  let at = node.start + 1;
  let comma = false;
  for (const s of spans) {
    const lead = text.slice(at, s.start);
    const after = skipBlank(text, s.end);
    comma = text[after] === ",";
    // A comment on the member's own line stays with it; the rest goes to the next one.
    const eol = text.indexOf("\n", s.end);
    const end = comma ? after : Math.min(after, eol < 0 ? after : eol);
    let trail = text.slice(s.end, end);
    at = comma ? after + 1 : end;
    if (comma) {
      // A comment after the comma, on the same line.
      const eol2 = text.indexOf("\n", at);
      const rest = text.slice(at, eol2 < 0 ? text.length : eol2);
      if (rest.trim() && /^[ \t]*(\/\/.*|\/\*.*?\*\/[ \t]*)$/.test(rest) && at + rest.length < node.end) {
        trail += rest;
        at += rest.length;
      }
    }
    segments.push({ lead, trail });
  }
  return { segments, comma, tail: text.slice(at, node.end - 1) };
}
