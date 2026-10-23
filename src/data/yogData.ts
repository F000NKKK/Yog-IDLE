/**
 * Yog Data — the one syntax of every Yog format — read and written by the
 * CLI (`yog serve`, Rust `yog_data`): the IDE neither parses nor formats
 * it. Reading gives plain JS values; writing changes a file's text to hold
 * a new value, keeping comments and layout of what didn't change.
 */
import { errorText } from "substrate-platform-ui";
import { serveMethod } from "../data/yogIds.generated";
import { cli } from "../toolchain/cli";
import { prefetchTyped, stringsOf } from "./typed";

/** A file read: its value, or what's wrong with it (`line:col: message`). */
export type Read<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Reads Yog Data `text`. `ordered`: maps as `Map`s in file order — for a
 * map whose keys JS objects would reorder (times: `"0"`, `"0.25"`, `"1"`).
 */
export async function readData(text: string, opts: { ordered?: boolean } = {}): Promise<Read> {
  try {
    const value = await cli<unknown>(serveMethod.DATA_PARSE, { text }, { ordered: opts.ordered });
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
  return cli<string>(serveMethod.DATA_PATCH, { text, next });
}

/** `value` as Yog's editors write it, at indent `level`. */
export function formatData(value: unknown, level = 0): Promise<string> {
  return cli<string>(serveMethod.DATA_FORMAT, { value, level });
}

/** Source-only keys every object may have: `$…`, `_…`, `comment`. */
export function isMetadataKey(key: string): boolean {
  return key.startsWith("$") || key.startsWith("_") || key === "comment";
}

/** A map's entries — a `Map`'s in its order, an object's as JS orders them. */
export const entriesOf = (v: object): [string, unknown][] => (v instanceof Map ? [...v.entries()] : Object.entries(v));
