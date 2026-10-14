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

/** Parses Yog Data text to a plain JS value, like `JSON.parse` for the wider syntax; throws `DataSyntaxError`. */
export function parseDataValue(text: string): unknown {
  return toPlain(parseData(text));
}
