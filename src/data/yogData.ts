/**
 * Yog Data — the one syntax of every Yog format — read and written by the
 * CLI (`yog serve`, Rust `yog_data`): the IDE neither parses nor formats
 * it. Reading gives plain JS values; writing changes a file's text to hold
 * a new value, keeping comments and layout of what didn't change.
 */
import { cli } from "../cli";

/** A file read: its value, or what's wrong with it (`line:col: message`). */
export type Read<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

/** The CLI's error as text. */
export function errorText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

/**
 * Reads Yog Data `text`. `ordered`: maps as `Map`s in file order — for a
 * map whose keys JS objects would reorder (times: `"0"`, `"0.25"`, `"1"`).
 */
export async function readData(text: string, opts: { ordered?: boolean } = {}): Promise<Read> {
  try {
    const json = await cli<string>("data.parse", { text });
    return { ok: true, value: opts.ordered ? parseJsonOrdered(json) : JSON.parse(json) };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** Reads a file that is one object (an empty one: `{}`). */
export async function readObject<T>(text: string, opts: { ordered?: boolean } = {}): Promise<Read<T>> {
  if (!text.trim()) return { ok: true, value: (opts.ordered ? new Map() : {}) as T };
  const r = await readData(text, opts);
  if (!r.ok) return r;
  const v = r.value;
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "The file must be one object." };
  return { ok: true, value: v as T };
}

/** `text` changed to hold `next`: what changed written anew, the rest — comments too — as it was. */
export function patchData(text: string, next: unknown): Promise<string> {
  return cli<string>("data.patch", { text, next: toJson(next) });
}

/** `value` as Yog's editors write it, at indent `level`. */
export function formatData(value: unknown, level = 0): Promise<string> {
  return cli<string>("data.format", { value: toJson(value), level });
}

/** `value` as JSON text, a `Map`'s keys in its order; `undefined` members left out. */
export function toJson(value: unknown): string {
  if (value instanceof Map || (value && typeof value === "object" && !Array.isArray(value))) {
    const parts = entriesOf(value as object)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}:${toJson(v)}`);
    return `{${parts.join(",")}}`;
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : toJson(v))).join(",")}]`;
  return JSON.stringify(value ?? null);
}

/** JSON text (as `data.parse` gives it) with its objects as `Map`s, in order. */
function parseJsonOrdered(json: string): unknown {
  let i = 0;
  const ws = () => {
    while (/\s/.test(json[i] ?? "")) i++;
  };
  const value = (): unknown => {
    ws();
    const c = json[i];
    if (c === "{") {
      i++;
      const map = new Map<string, unknown>();
      ws();
      if (json[i] === "}") return i++, map;
      for (;;) {
        ws();
        const key = string();
        ws();
        i++; // :
        map.set(key, value());
        ws();
        if (json[i++] === "}") return map;
      }
    }
    if (c === "[") {
      i++;
      const list: unknown[] = [];
      ws();
      if (json[i] === "]") return i++, list;
      for (;;) {
        list.push(value());
        ws();
        if (json[i++] === "]") return list;
      }
    }
    if (c === '"') return string();
    // A number, `true`, `false` or `null`: up to the next delimiter.
    const start = i;
    while (i < json.length && !/[,\]}\s]/.test(json[i])) i++;
    return JSON.parse(json.slice(start, i));
  };
  const string = (): string => {
    const start = i++;
    while (json[i] !== '"') i += json[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(json.slice(start, i)) as string;
  };
  return value();
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

/** A map's entries — a `Map`'s in its order, an object's as JS orders them. */
export const entriesOf = (v: object): [string, unknown][] => (v instanceof Map ? [...v.entries()] : Object.entries(v));
