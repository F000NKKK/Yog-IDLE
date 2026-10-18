// What a content reference (`@item:…`, `@entity:…`, `@effect:…`) may name,
// as the backend lists it (`content_refs` — the mod's own content, the ids
// it declares in yog.toml, the game's from the client jar), and the one
// check every designer's picker runs on what's typed — the same rule
// `yog build` checks references by.

import { useCallback, useEffect, useState } from "react";
import { cli } from "../cli";
import { fileTypeOf } from "substrate-platform-ui";
import { useFsChanged } from "../fsWatch";
import { classify } from "./typed";
import { fileTypeId, formats } from "../yogFileTypes";

/** One of the mod's own: its id and the file that defines it. */
export interface OwnRef {
  id: string;
  file: string;
}

export interface RefChoices {
  own: OwnRef[];
  /** Another mod's, declared in yog.toml (`[external.<ns>]`). */
  external: string[];
  /** The game's; empty without a client jar on this machine. */
  game: string[];
}

/** One of the mod's `.ydef`s with what it says. */
export interface OwnDef {
  id: string;
  file: string;
  value: Record<string, unknown>;
}

export const NO_REFS: RefChoices = { own: [], external: [], game: [] };

/** The file types whose changes can change what's listed. */
const CONTENT_TYPES = new Set([fileTypeId(formats.block), fileTypeId(formats.item), fileTypeId(formats.entity), fileTypeId(formats.def), fileTypeId(formats.model), fileTypeId(formats.anim), fileTypeId(formats.recipe)]);

/** Asks again whenever a content file changes on disk. */
function useContentReload(): [number, () => void] {
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  useFsChanged((paths) => {
    if (paths.some((p) => CONTENT_TYPES.has(fileTypeOf(p)?.id ?? "") || /yog\.toml$/.test(p))) reload();
  });
  return [asked, reload];
}

/**
 * What `@<kind>:` may name for the file at `path` (`kind` may also be a
 * body format, `ymodel`/`yanim`): `NO_REFS` until it's known.
 */
export function useContentRefs(path: string, kind: string): RefChoices {
  const [choices, setChoices] = useState<RefChoices>(NO_REFS);
  const [asked] = useContentReload();
  useEffect(() => {
    let live = true;
    cli<RefChoices>("content_refs", { path, kind })
      .then((c) => live && setChoices(c ?? NO_REFS))
      .catch(() => live && setChoices(NO_REFS));
    return () => {
      live = false;
    };
  }, [path, kind, asked]);
  return choices;
}

/** The mod's `.ydef`s of `kind` with what they say (empty until known). */
export function useContentDefs(path: string, kind: string): OwnDef[] {
  const [defs, setDefs] = useState<OwnDef[]>([]);
  const [asked] = useContentReload();
  useEffect(() => {
    let live = true;
    cli<OwnDef[]>("content_defs", { path, kind })
      .then((d) => live && setDefs(d ?? []))
      .catch(() => live && setDefs([]));
    return () => {
      live = false;
    };
  }, [path, kind, asked]);
  return defs;
}

/** Every id a reference may name, the mod's first. */
export function refIds(c: RefChoices): string[] {
  return [...c.own.map((o) => o.id), ...c.external, ...c.game];
}

/** `@<kind>:<id>` for each id a picker offers, the mod's first. */
export function refSuggestions(c: RefChoices, kind: string): string[] {
  return refIds(c).map((id) => `@${kind}:${id}`);
}

/** `id` with the namespace `ns` when it has none (`wisp` → `mymod:wisp`). */
export function qualify(id: string, ns: string): string {
  return id.includes(":") ? id : `${ns}:${id}`;
}

/** The id a reference names (`@item:minecraft:stick` → `minecraft:stick`), `null` if it isn't a reference of `kind`. */
export function refId(value: string, kind: string): string | null {
  try {
    const v = classify(value);
    return v.t === "ref" && v.kind === kind ? v.id : null;
  } catch {
    return null;
  }
}

export type RefProblem = { t: "syntax"; kind: string } | { t: "unknown"; id: string } | null;

/**
 * What's wrong with `value` as a reference of `kind` (`@<kind>:<id>`, or a
 * `@tag:<kind>:…` where `tags` allows it): `null` when it's one the mod,
 * its declared mods or the game has — or the game's can't be listed here
 * (no client jar), for a `minecraft:` id. An empty value is fine (unset).
 */
export function refProblem(value: string, kind: string, c: RefChoices, tags = false): RefProblem {
  const s = value.trim();
  if (!s) return null;
  let v;
  try {
    v = classify(s);
  } catch {
    return { t: "syntax", kind };
  }
  // Not classified yet: nothing to say until it is.
  if (v.t === "pending") return null;
  if (tags && v.t === "tag" && v.kind === kind) return null;
  if (v.t !== "ref" || v.kind !== kind) return { t: "syntax", kind };
  if (c === NO_REFS) return null;
  const known = refIds(c).includes(v.id) || (v.id.startsWith("minecraft:") && c.game.length === 0);
  return known ? null : { t: "unknown", id: v.id };
}
