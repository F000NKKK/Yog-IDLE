// `.yrecipe` ⇄ what the recipe editor edits. A shaped recipe is a 3×3 grid
// of cells here; its `pattern`/`key` are made from the grid on save (empty
// edge rows and columns dropped, a letter picked per ingredient), so the
// editor never shows them. Cells hold plain ids as the item picker gives
// them (`minecraft:paper`, `#c:dusts` for a tag, alternatives joined by
// ` | `); the file has Yog Data references (`@item:minecraft:paper`,
// `@tag:item:c:dusts`, a list of them).

import { parseDataValue } from "../data/yogData";

export type RecipeType = "shaped" | "shapeless" | "smelting";

export interface Recipe {
  type: RecipeType;
  /** Shaped: the 3×3 grid, row by row (null = empty). Shapeless: up to 9 ingredients, in order. Smelting: cell 0. */
  cells: (string | null)[];
  result: string;
  count: number;
  /** Smelting only. */
  experience: number;
  cookTime: number;
  /** Keys the editor doesn't know (`id`, `$schema`, ...), written back as they were. */
  extra: Record<string, unknown>;
}

export const GRID = 9;
const DEFAULT_EXPERIENCE = 0.1;
const DEFAULT_COOK_TIME = 200;
const KNOWN = new Set(["type", "pattern", "key", "ingredients", "ingredient", "result", "count", "experience", "cook_time"]);

export function emptyRecipe(): Recipe {
  return { type: "shaped", cells: Array(GRID).fill(null), result: "", count: 1, experience: DEFAULT_EXPERIENCE, cookTime: DEFAULT_COOK_TIME, extra: {} };
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** A reference as the editor shows it: `@item:x` → `x`, `@tag:item:x` → `#x`. */
export function fromRef(s: string): string {
  if (s.startsWith("@tag:item:")) return `#${s.slice("@tag:item:".length)}`;
  if (s.startsWith("@item:")) return s.slice("@item:".length);
  if (s.startsWith("@block:")) return s.slice("@block:".length);
  return s;
}

/** An id as the file writes it: `x` → `@item:x`, `#x` → `@tag:item:x`. */
export function toRef(s: string): string {
  if (s.startsWith("#")) return `@tag:item:${s.slice(1)}`;
  return s.startsWith("@") ? s : `@item:${s}`;
}

/** An ingredient (a reference or a list of them) as a cell: ids joined by ` | `. */
function cellOf(v: unknown): string | null {
  const list = (Array.isArray(v) ? v : [v]).map(str).filter((s): s is string => !!s);
  return list.length ? list.map(fromRef).join(" | ") : null;
}

/** A cell as an ingredient: one reference, or a list of them. */
function ingredientOf(cell: string): string | string[] {
  const alts = cell.split("|").map((s) => s.trim()).filter(Boolean).map(toRef);
  return alts.length === 1 ? alts[0] : alts;
}

/** The recipe types the editor lays out; other kinds are edited as code. */
export const EDITED_TYPES: readonly string[] = ["shaped", "shapeless", "smelting"];

/** The recipe in `text`, or `null` when it isn't one the editor lays out (not an object, another kind). */
export function parseRecipe(text: string): Recipe | null {
  let j: unknown;
  try {
    j = parseDataValue(text);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (o.type !== undefined && !EDITED_TYPES.includes(String(o.type))) return null;
  const r = emptyRecipe();
  r.type = o.type === "shapeless" || o.type === "smelting" ? o.type : "shaped";
  r.result = fromRef(str(o.result) ?? "");
  r.count = Math.max(1, Math.min(64, Math.round(num(o.count, 1))));
  r.experience = num(o.experience, DEFAULT_EXPERIENCE);
  r.cookTime = Math.round(num(o.cook_time, DEFAULT_COOK_TIME));
  for (const [k, v] of Object.entries(o)) if (!KNOWN.has(k)) r.extra[k] = v;
  if (r.type === "shaped") {
    const pattern = Array.isArray(o.pattern) ? o.pattern.map((row) => String(row)) : [];
    const key = o.key && typeof o.key === "object" ? (o.key as Record<string, unknown>) : {};
    pattern.slice(0, 3).forEach((row, y) =>
      [...row].slice(0, 3).forEach((c, x) => {
        r.cells[y * 3 + x] = c === " " ? null : cellOf(key[c]);
      })
    );
  } else if (r.type === "shapeless") {
    const list = Array.isArray(o.ingredients) ? o.ingredients.map(cellOf).filter((s): s is string => !!s) : [];
    list.slice(0, GRID).forEach((s, i) => (r.cells[i] = s));
  } else {
    r.cells[0] = cellOf(o.ingredient);
  }
  return r;
}

/** A letter for `item`: its name's first letter when free, else the next free A–Z. */
function letterFor(item: string, used: Set<string>): string {
  const name = item.replace(/^#/, "").split("|")[0].trim().split(":").pop() ?? "";
  const first = name.charAt(0).toUpperCase();
  if (/[A-Z]/.test(first) && !used.has(first)) return first;
  for (let c = 65; c <= 90; c++) {
    const l = String.fromCharCode(c);
    if (!used.has(l)) return l;
  }
  return "#";
}

/** The `.yrecipe` text of `r`. */
export function serializeRecipe(r: Recipe): string {
  const out: Record<string, unknown> = { ...r.extra, type: r.type };
  if (r.type === "shaped") {
    const at = (x: number, y: number) => r.cells[y * 3 + x];
    const rows = [0, 1, 2].filter((y) => [0, 1, 2].some((x) => at(x, y)));
    const cols = [0, 1, 2].filter((x) => [0, 1, 2].some((y) => at(x, y)));
    const letters = new Map<string, string>();
    const used = new Set<string>();
    const pattern = rows.map((y) =>
      cols
        .map((x) => {
          const item = at(x, y);
          if (!item) return " ";
          let l = letters.get(item);
          if (!l) {
            l = letterFor(item, used);
            used.add(l);
            letters.set(item, l);
          }
          return l;
        })
        .join("")
    );
    out.pattern = pattern;
    out.key = Object.fromEntries([...letters].map(([item, l]) => [l, ingredientOf(item)]));
  } else if (r.type === "shapeless") {
    out.ingredients = r.cells.filter((c): c is string => !!c).map(ingredientOf);
  } else {
    out.ingredient = r.cells[0] ? ingredientOf(r.cells[0]) : "";
  }
  out.result = r.result ? toRef(r.result) : "";
  if (r.count !== 1) out.count = r.count;
  if (r.type === "smelting") {
    if (r.experience !== DEFAULT_EXPERIENCE) out.experience = r.experience;
    if (r.cookTime !== DEFAULT_COOK_TIME) out.cook_time = r.cookTime;
  }
  return JSON.stringify(out, null, 2) + "\n";
}


// ── The mod's own kinds (`.ydef` `recipe_kind`) ─────────────────────────────

/** `recipe_kinds::Kind` — a kind the mod declares. */
export interface RecipeKind {
  id: string;
  file: string;
  slots: { name: string; max: number; required: boolean }[];
  values: { name: string; kind: "number" | "text" | "bool" }[];
  layout: {
    /** The `.yui` (`recipe_layout`) it's laid out in. */
    file: string;
    size: [number, number];
    image: string | null;
    scale: number;
    spots: (
      | { type: "slot"; slot: string; index: number; at: [number, number] }
      | { type: "result"; at: [number, number] }
      | { type: "count"; at: [number, number] }
      | { type: "text"; text: string; at: [number, number] }
    )[];
  } | null;
}

/** A recipe of a mod's kind: `{ type: "mymod:crusher", slots: { input: […] }, values: { time: 200 }, result, count }`. */
export interface CustomRecipe {
  type: string;
  /** Per slot its cells (as the grid's: ids, `#tag`, alternatives joined by ` | `). */
  slots: Record<string, (string | null)[]>;
  values: Record<string, number | string | boolean>;
  result: string;
  count: number;
  extra: Record<string, unknown>;
}

const CUSTOM_KNOWN = new Set(["type", "slots", "values", "result", "count"]);

/** Whether `type` is a mod's kind (`ns:kind`), not one of the game's. */
export function isCustomType(type: unknown): type is string {
  return typeof type === "string" && type.includes(":") && !type.startsWith("minecraft:");
}

/** The recipe of a mod's kind in `text`, else `null`. */
export function parseCustomRecipe(text: string): CustomRecipe | null {
  let j: unknown;
  try {
    j = parseDataValue(text);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (!isCustomType(o.type)) return null;
  const slots: CustomRecipe["slots"] = {};
  if (o.slots && typeof o.slots === "object" && !Array.isArray(o.slots)) {
    for (const [name, v] of Object.entries(o.slots as Record<string, unknown>)) {
      slots[name] = (Array.isArray(v) ? v : [v]).map(cellOf);
    }
  }
  const values: CustomRecipe["values"] = {};
  if (o.values && typeof o.values === "object" && !Array.isArray(o.values)) {
    for (const [name, v] of Object.entries(o.values as Record<string, unknown>)) {
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") values[name] = v;
    }
  }
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!CUSTOM_KNOWN.has(k)) extra[k] = v;
  return { type: o.type, slots, values, result: fromRef(str(o.result) ?? ""), count: Math.max(1, Math.min(64, Math.round(num(o.count, 1)))), extra };
}

/** The `.yrecipe` text of a recipe of a mod's kind; `kind` orders its slots and values as declared. */
export function serializeCustomRecipe(r: CustomRecipe, kind?: RecipeKind): string {
  const out: Record<string, unknown> = { ...r.extra, type: r.type };
  const slotNames = kind ? kind.slots.map((s) => s.name) : Object.keys(r.slots);
  const slots: Record<string, unknown> = {};
  for (const name of slotNames) {
    const cells = (r.slots[name] ?? []).filter((c): c is string => !!c);
    if (cells.length) slots[name] = cells.map(ingredientOf);
  }
  if (Object.keys(slots).length) out.slots = slots;
  const valueNames = kind ? kind.values.map((v) => v.name) : Object.keys(r.values);
  const values: Record<string, unknown> = {};
  for (const name of valueNames) if (r.values[name] !== undefined) values[name] = r.values[name];
  if (Object.keys(values).length) out.values = values;
  out.result = r.result ? toRef(r.result) : "";
  if (r.count !== 1) out.count = r.count;
  return JSON.stringify(out, null, 2) + "\n";
}

/** A recipe of `kind` keeping `from`'s result and count (switching kinds). */
export function customFrom(kind: RecipeKind, from: { result: string; count: number }): CustomRecipe {
  const values: CustomRecipe["values"] = {};
  for (const v of kind.values) values[v.name] = v.kind === "number" ? 0 : v.kind === "bool" ? false : "";
  return { type: kind.id, slots: {}, values, result: from.result, count: from.count, extra: {} };
}
