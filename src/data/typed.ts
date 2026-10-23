// Typed values (`@item:minecraft:stick`, `@tag:item:…`, `@Set.key`,
// `@image:…`, `@lang:…`) as the CLI reads them (`typed.classify`, Rust
// `yog_data::typed`) — the IDE has no rules of its own. Reading is
// synchronous from a cache: a file's values are classified when it's read
// (`prefetchTyped`), a new one is asked for and its readers re-render when
// it's in (`useTyped`).
import { useSyncExternalStore } from "react";
import { serveMethod } from "../data/yogIds.generated";
import { cli } from "../toolchain/cli";
import { sep } from "./yogIds.generated";

/** A typed value's string form, read; `pending` until the CLI has answered. */
export type Typed =
  | { t: "str"; v: string }
  | { t: "ref"; kind: string; id: string }
  | { t: "tag"; kind: string; id: string }
  | { t: "res"; set: string; key: string }
  | { t: "image"; source: string }
  | { t: "lang"; key: string }
  | { t: "bytes" }
  | { t: "pending" };

type Answer = Exclude<Typed, { t: "pending" }> | { error: string };

const cache = new Map<string, Answer>();
const asked = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let batch: string[] = [];

function settle(values: string[], answers: Answer[]) {
  values.forEach((v, i) => {
    cache.set(v, answers[i] ?? { error: "no answer" });
    asked.delete(v);
  });
  version++;
  listeners.forEach((l) => l());
}

/** Asks the CLI about `values` it hasn't answered yet; resolves when it has. */
export async function prefetchTyped(values: Iterable<string>): Promise<void> {
  const fresh = [...new Set(values)].filter((v) => v.startsWith(sep.TYPED) && !cache.has(v) && !asked.has(v));
  if (!fresh.length) return;
  fresh.forEach((v) => asked.add(v));
  let answers: Answer[];
  try {
    answers = await cli<Answer[]>(serveMethod.TYPED_CLASSIFY, { values: fresh });
  } catch {
    // The CLI didn't answer (restarting, updating): asked again later, nothing kept.
    fresh.forEach((v) => asked.delete(v));
    setTimeout(() => void prefetchTyped(fresh), RETRY_MS);
    return;
  }
  settle(fresh, answers);
}

/** How long after the CLI failed to answer it's asked again. */
const RETRY_MS = 2000;

/** Every string in a value read from a file, all the way down. */
export function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsOf(v, out));
  else if (value instanceof Map) value.forEach((v) => stringsOf(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => stringsOf(v, out));
  return out;
}

/** `s` as a typed value or plain text; throws on a malformed `@…`; `pending` while the CLI is asked. */
export function classify(s: string): Typed {
  if (!s.startsWith(sep.TYPED)) return { t: "str", v: s };
  const answer = cache.get(s);
  if (!answer) {
    // Asked with the others of this tick.
    if (!batch.length) queueMicrotask(() => void prefetchTyped(batch.splice(0)));
    batch.push(s);
    return { t: "pending" };
  }
  if ("error" in answer) throw new Error(answer.error);
  return answer;
}

/** Re-renders the caller when classified values come in. */
export function useTyped(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}
