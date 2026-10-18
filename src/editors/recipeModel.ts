// `.yrecipe` ⇄ what the recipe editor edits, for every kind alike — the
// game's and the mod's — by the kind's definition (`recipe_kinds` on the
// Rust side): each slot is a list of places, read from the field the
// definition names (a grid slot from `pattern` and `key`, a mod's kind's
// slots from `slots`), each value from its field (a mod's from `values`).
// Places hold plain ids as the item picker gives them (`minecraft:paper`,
// `#c:dusts` for a tag, alternatives joined by ` | `); the file has Yog Data
// references. Writing patches the file's text: its comments and layout stay.

import { ALTERNATIVES, TAG_MARK, refOf, shownOf, showIngredient, writeIngredient } from "../data/ingredients";
import { isObject, num, str } from "../data/values";
import { formatData, parseDataValue, patchDataText } from "../data/yogData";
import { MAX_STACK_SIZE } from "../data/yogFormat";

/** `recipe_kinds::Slot`. */
export interface RecipeSlot {
  name: string;
  /** What editors call it; `name` if none. */
  label?: string | null;
  description?: string | null;
  max: number;
  required: boolean;
  /** The game's kinds: the `.yrecipe` field it's written in. */
  field?: string | null;
  /** Its places are a crafting grid's, written as `pattern` and `key`. */
  grid: boolean;
}

/** `recipe_kinds::ValueSpec`. */
export interface RecipeValue {
  name: string;
  kind: "number" | "text" | "bool";
  default?: number | null;
}

/** `recipe_kinds::Spot` — where the layout puts something, in GUI pixels. */
export type LayoutSpot =
  | { type: "slot"; slot: string; index: number; at: [number, number] }
  | { type: "result"; at: [number, number] }
  | { type: "count"; at: [number, number] }
  | { type: "text"; text: string; at: [number, number] };

/** `recipe_kinds::Kind`. */
export interface RecipeKind {
  id: string;
  label?: string | null;
  /** The `.ydef` declaring it; empty for the game's. */
  file: string;
  slots: RecipeSlot[];
  values: RecipeValue[];
  layout: {
    /** The `.yui` it's laid out in; empty for a built-in layout. */
    file: string;
    size: [number, number];
    image: string | null;
    scale: number;
    spots: LayoutSpot[];
  } | null;
}

/** `recipe_kinds::Fields` — the format's names for what every recipe has. */
export interface RecipeFields {
  type: string;
  result: string;
  count: string;
  slots: string;
  values: string;
  pattern: string;
  key: string;
  gridSide: number;
}

/** A recipe of any kind. */
export interface Recipe {
  type: string;
  /** Per slot, its places (null = empty). */
  slots: Record<string, (string | null)[]>;
  values: Record<string, number | string | boolean>;
  result: string;
  count: number;
}

const clampCount = (n: number) => Math.max(1, Math.min(MAX_STACK_SIZE, Math.round(n)));
/** An empty place in a grid's pattern row. */
const EMPTY_KEY = " ";

/** The parsed object of a `.yrecipe`, or `null` when it isn't one. */
function objectOf(text: string): Record<string, unknown> | null {
  try {
    const v = parseDataValue(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

/** The kind (`type`) of the recipe in `text`, if it says one. */
export function recipeType(text: string, fields: RecipeFields): string | null {
  return str(objectOf(text)?.[fields.type]);
}

/** Whether `kind` is one of the game's (its slots are written in fields of their own). */
const isGameKind = (kind: RecipeKind) => kind.file === "";

/** A grid's places from `pattern` rows and their `key`. */
function readGrid(o: Record<string, unknown>, fields: RecipeFields): (string | null)[] {
  const side = fields.gridSide;
  const places: (string | null)[] = Array(side * side).fill(null);
  const pattern = Array.isArray(o[fields.pattern]) ? (o[fields.pattern] as unknown[]).map(String) : [];
  const key = isObject(o[fields.key]) ? (o[fields.key] as Record<string, unknown>) : {};
  pattern.slice(0, side).forEach((row, y) =>
    [...row].slice(0, side).forEach((c, x) => {
      places[y * side + x] = c === EMPTY_KEY ? null : showIngredient(key[c]);
    }),
  );
  return places;
}

/** A letter for `place`'s key: its name's first letter when free, else the next free A–Z. */
function letterFor(place: string, used: Set<string>): string {
  const name = place.replace(TAG_MARK, "").split(ALTERNATIVES)[0].trim().split(":").pop() ?? "";
  const first = name.charAt(0).toUpperCase();
  if (/[A-Z]/.test(first) && !used.has(first)) return first;
  for (let c = "A".charCodeAt(0); c <= "Z".charCodeAt(0); c++) {
    const l = String.fromCharCode(c);
    if (!used.has(l)) return l;
  }
  return TAG_MARK;
}

/** `pattern` rows (empty edge rows and columns dropped) and `key` for a grid's places. */
function writeGrid(places: (string | null)[], side: number): { pattern: string[]; key: Record<string, unknown> } {
  const at = (x: number, y: number) => places[y * side + x];
  const span = [...Array(side).keys()];
  const rows = span.filter((y) => span.some((x) => at(x, y)));
  const cols = span.filter((x) => span.some((y) => at(x, y)));
  const letters = new Map<string, string>();
  const used = new Set<string>();
  const pattern = rows.map((y) =>
    cols
      .map((x) => {
        const place = at(x, y);
        if (!place) return EMPTY_KEY;
        let l = letters.get(place);
        if (!l) {
          l = letterFor(place, used);
          used.add(l);
          letters.set(place, l);
        }
        return l;
      })
      .join(""),
  );
  return { pattern, key: Object.fromEntries([...letters].map(([place, l]) => [l, writeIngredient(place)])) };
}

/** The recipe in `text`, read as a recipe of `kind`; `null` if it isn't an object. */
export function parseRecipe(text: string, kind: RecipeKind, fields: RecipeFields): Recipe | null {
  const o = objectOf(text);
  if (!o) return null;
  const game = isGameKind(kind);
  const ownSlots = isObject(o[fields.slots]) ? (o[fields.slots] as Record<string, unknown>) : {};
  const ownValues = isObject(o[fields.values]) ? (o[fields.values] as Record<string, unknown>) : {};
  const slots: Recipe["slots"] = {};
  for (const s of kind.slots) {
    if (s.grid) slots[s.name] = readGrid(o, fields);
    else {
      const v = game ? (s.field ? o[s.field] : undefined) : ownSlots[s.name];
      slots[s.name] = s.max > 1 && Array.isArray(v) ? v.map(showIngredient) : [showIngredient(v)];
    }
  }
  const values: Recipe["values"] = {};
  for (const v of kind.values) {
    const given = game ? o[v.name] : ownValues[v.name];
    if (typeof given === "number" || typeof given === "string" || typeof given === "boolean") values[v.name] = given;
    else if (v.default != null) values[v.name] = v.default;
  }
  return { type: kind.id, slots, values, result: shownOf(str(o[fields.result]) ?? ""), count: clampCount(num(o[fields.count], 1)) };
}

/** The `.yrecipe` text `text` becomes with `r` (a recipe of `kind`), its other keys, comments and layout kept. */
export function serializeRecipe(text: string, r: Recipe, kind: RecipeKind, fields: RecipeFields): string {
  const game = isGameKind(kind);
  const o: Record<string, unknown> = { ...(objectOf(text) ?? {}) };
  o[fields.type] = r.type;
  const ownSlots: Record<string, unknown> = {};
  for (const s of kind.slots) {
    const places = r.slots[s.name] ?? [];
    if (s.grid) {
      const { pattern, key } = writeGrid(places, fields.gridSide);
      o[fields.pattern] = pattern;
      o[fields.key] = key;
      continue;
    }
    const filled = places.filter((p): p is string => !!p).map(writeIngredient);
    const value = s.max > 1 ? filled : (filled[0] ?? "");
    if (game && s.field) o[s.field] = value;
    else if (filled.length) ownSlots[s.name] = filled;
  }
  const ownValues: Record<string, unknown> = {};
  for (const v of kind.values) {
    const given = r.values[v.name];
    const isDefault = given === undefined || (v.default != null && given === v.default);
    if (game) {
      if (isDefault) delete o[v.name];
      else o[v.name] = given;
    } else if (given !== undefined) ownValues[v.name] = given;
  }
  if (!game) {
    if (Object.keys(ownSlots).length) o[fields.slots] = ownSlots;
    else delete o[fields.slots];
    if (Object.keys(ownValues).length) o[fields.values] = ownValues;
    else delete o[fields.values];
  }
  o[fields.result] = r.result ? refOf(r.result) : "";
  if (r.count !== 1) o[fields.count] = r.count;
  else delete o[fields.count];
  return patchDataText(text, o, formatData);
}

/** A recipe of `kind` keeping `from`'s result and count (switching kinds); the old kind's own fields dropped. */
export function switchKind(text: string, from: Recipe | null, kind: RecipeKind, kinds: RecipeKind[], fields: RecipeFields): string {
  const o = objectOf(text) ?? {};
  // What belonged to the kind it was: its slots' and values' fields.
  for (const k of kinds) {
    for (const s of k.slots) if (s.field) delete o[s.field];
    for (const v of k.values) delete o[v.name];
  }
  for (const f of [fields.pattern, fields.key, fields.slots, fields.values]) delete o[f];
  const values: Recipe["values"] = {};
  for (const v of kind.values) values[v.name] = v.default ?? (v.kind === "number" ? 0 : v.kind === "bool" ? false : "");
  const next: Recipe = { type: kind.id, slots: {}, values, result: from?.result ?? "", count: from?.count ?? 1 };
  return serializeRecipe(patchDataText(text, o, formatData), next, kind, fields);
}
