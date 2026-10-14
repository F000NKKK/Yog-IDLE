// `.yrecipe` ⇄ what the recipe editor edits. A shaped recipe is a 3×3 grid
// of cells here; its `pattern`/`key` are made from the grid on save (empty
// edge rows and columns dropped, a letter picked per ingredient), so the
// editor never shows them.

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

/** The recipe in `text`, or `null` when it isn't a JSON object. */
export function parseRecipe(text: string): Recipe | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  const r = emptyRecipe();
  r.type = o.type === "shapeless" || o.type === "smelting" ? o.type : "shaped";
  r.result = str(o.result) ?? "";
  r.count = Math.max(1, Math.min(64, Math.round(num(o.count, 1))));
  r.experience = num(o.experience, DEFAULT_EXPERIENCE);
  r.cookTime = Math.round(num(o.cook_time, DEFAULT_COOK_TIME));
  for (const [k, v] of Object.entries(o)) if (!KNOWN.has(k)) r.extra[k] = v;
  if (r.type === "shaped") {
    const pattern = Array.isArray(o.pattern) ? o.pattern.map((row) => String(row)) : [];
    const key = o.key && typeof o.key === "object" ? (o.key as Record<string, unknown>) : {};
    pattern.slice(0, 3).forEach((row, y) =>
      [...row].slice(0, 3).forEach((c, x) => {
        r.cells[y * 3 + x] = c === " " ? null : (str(key[c]) ?? null);
      })
    );
  } else if (r.type === "shapeless") {
    const list = Array.isArray(o.ingredients) ? o.ingredients.map(str).filter((s): s is string => !!s) : [];
    list.slice(0, GRID).forEach((s, i) => (r.cells[i] = s));
  } else {
    r.cells[0] = str(o.ingredient);
  }
  return r;
}

/** A letter for `item`: its name's first letter when free, else the next free A–Z. */
function letterFor(item: string, used: Set<string>): string {
  const name = item.replace(/^#/, "").split(":").pop() ?? "";
  const first = name.charAt(0).toUpperCase();
  if (/[A-Z]/.test(first) && !used.has(first)) return first;
  for (let c = 65; c <= 90; c++) {
    const l = String.fromCharCode(c);
    if (!used.has(l)) return l;
  }
  return "#";
}

/** The `.yrecipe` JSON of `r`. */
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
    out.key = Object.fromEntries([...letters].map(([item, l]) => [l, item]));
  } else if (r.type === "shapeless") {
    out.ingredients = r.cells.filter((c): c is string => !!c);
  } else {
    out.ingredient = r.cells[0] ?? "";
  }
  out.result = r.result;
  if (r.count !== 1) out.count = r.count;
  if (r.type === "smelting") {
    if (r.experience !== DEFAULT_EXPERIENCE) out.experience = r.experience;
    if (r.cookTime !== DEFAULT_COOK_TIME) out.cook_time = r.cookTime;
  }
  return JSON.stringify(out, null, 2) + "\n";
}

/** How many cells the recipe's type uses. */
export function cellCount(type: RecipeType): number {
  return type === "smelting" ? 1 : GRID;
}
