/**
 * Yog Data — the one syntax of every Yog format — read and written by the
 * CLI (`yog serve`, Rust `yog_data`): the IDE neither parses nor formats
 * it. Reading gives plain JS values; writing changes a file's text to hold
 * a new value, keeping comments and layout of what didn't change.
 */
import { cli } from "../cli";
import { prefetchTyped, stringsOf } from "./typed";

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
    const value = opts.ordered ? parseJsonOrdered(json) : JSON.parse(json);
    // Its typed values classified now, so the designers read them at once.
    await prefetchTyped(stringsOf(value));
    return { ok: true, value };
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

/** A map's entries — a `Map`'s in its order, an object's as JS orders them. */
export const entriesOf = (v: object): [string, unknown][] => (v instanceof Map ? [...v.entries()] : Object.entries(v));
