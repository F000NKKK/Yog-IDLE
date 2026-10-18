import { describe, expect, it } from "vitest";
import { readData } from "../data/yogData";
import { parseRecipe, recipeType, serializeRecipe, switchKind, type RecipeFields, type RecipeKind } from "./recipeModel";

// What `recipe_kinds` sends (src-tauri/src/recipe_kinds.rs), for the kinds these tests use.
const FIELDS: RecipeFields = { type: "type", result: "result", count: "count", slots: "slots", values: "values", pattern: "pattern", key: "key", gridSide: 3 };
const game = (id: string, slots: RecipeKind["slots"], values: RecipeKind["values"] = []): RecipeKind => ({ id, file: "", slots, values, layout: null });
const SHAPED = game("shaped", [{ name: "grid", max: 9, required: true, grid: true }]);
const SHAPELESS = game("shapeless", [{ name: "grid", max: 9, required: true, field: "ingredients", grid: false }]);
const SMELTING = game("smelting", [{ name: "input", max: 1, required: true, field: "ingredient", grid: false }], [
  { name: "cook_time", kind: "number", default: 200 },
  { name: "experience", kind: "number", default: 0.1 },
]);
const SMITHING = game("smithing", ["template", "base", "addition"].map((p) => ({ name: p, max: 1, required: true, field: p, grid: false })));
const BREWING = game("brewing", [
  { name: "from", max: 1, required: true, field: "from", grid: false },
  { name: "input", max: 1, required: true, field: "ingredient", grid: false },
]);
const CRUSHER: RecipeKind = {
  id: "mymod:crusher",
  file: "content/crusher.ydef",
  slots: [
    { name: "input", max: 1, required: true, grid: false },
    { name: "extra", max: 2, required: false, grid: false },
  ],
  values: [{ name: "time", kind: "number" }],
  layout: null,
};
const KINDS = [SHAPED, SHAPELESS, SMELTING, SMITHING, BREWING, CRUSHER];
const read = async (text: string | Promise<string>) => {
  const r = await readData(await text);
  if (!r.ok) throw new Error(r.error);
  return r.value as Record<string, unknown>;
};

describe("recipes of the game's kinds", () => {
  it("reads a shaped pattern into the grid and writes it back trimmed", async () => {
    const text = JSON.stringify({ type: "shaped", pattern: ["ISI", " S "], key: { I: "minecraft:iron_ingot", S: "minecraft:stick" }, result: "mymod:pick", id: "mymod:x" });
    const r = (await parseRecipe(text, SHAPED, FIELDS))!;
    expect(r.slots.grid).toEqual(["minecraft:iron_ingot", "minecraft:stick", "minecraft:iron_ingot", null, "minecraft:stick", null, null, null, null]);
    // Moved to the bottom-right corner: the empty edges go away again.
    const g = r.slots.grid;
    const moved = { ...r, slots: { grid: [null, null, null, null, g[0], g[1], null, g[4], null] } };
    const j = await read(serializeRecipe(text, moved, SHAPED, FIELDS));
    expect(j.pattern).toEqual(["IS", "S "]);
    expect(j.key).toEqual({ I: "@item:minecraft:iron_ingot", S: "@item:minecraft:stick" });
    expect(j.id, "keys the editor doesn't know stay").toBe("mymod:x");
    expect(j.count).toBeUndefined();
  });

  it("picks distinct letters", async () => {
    const text = '{ type: "shaped", pattern: [], key: {}, result: "a:b" }';
    const r = (await parseRecipe(text, SHAPED, FIELDS))!;
    r.slots.grid = ["minecraft:stone", "minecraft:stick", "minecraft:string", null, null, null, null, null, null];
    const j = await read(serializeRecipe(text, r, SHAPED, FIELDS));
    expect(new Set((j.pattern as string[])[0]).size).toBe(3);
    expect(Object.keys(j.key as object)).toHaveLength(3);
  });

  it("reads each slot from the field its definition names", async () => {
    const s = (await parseRecipe('{ type: "shapeless", ingredients: ["minecraft:paper", "#c:dusts"], result: "a:b", count: 2 }', SHAPELESS, FIELDS))!;
    expect(s.slots.grid).toEqual(["minecraft:paper", "#c:dusts"]);
    const b = (await parseRecipe('{ type: "brewing", from: "@item:yog:potion/awkward", ingredient: "@item:minecraft:sugar", result: "@item:yog:potion/swiftness" }', BREWING, FIELDS))!;
    expect(b.slots).toEqual({ from: ["yog:potion/awkward"], input: ["minecraft:sugar"] });
    const smith = (await parseRecipe('{ type: "smithing", template: "@item:minecraft:netherite_upgrade_smithing_template", base: "@item:minecraft:diamond_sword", addition: "@item:minecraft:netherite_ingot", result: "@item:minecraft:netherite_sword" }', SMITHING, FIELDS))!;
    expect(smith.slots.base).toEqual(["minecraft:diamond_sword"]);
  });

  it("values take their defaults, and a default isn't written", async () => {
    const text = '{ type: "smelting", ingredient: "minecraft:sand", result: "minecraft:glass", cook_time: 100 }';
    const f = (await parseRecipe(text, SMELTING, FIELDS))!;
    expect(f.values).toEqual({ cook_time: 100, experience: 0.1 });
    const j = await read(serializeRecipe(text, f, SMELTING, FIELDS));
    expect(j).toMatchObject({ ingredient: "@item:minecraft:sand", cook_time: 100 });
    expect(j.experience).toBeUndefined();
    const back = await read(serializeRecipe(text, { ...f, values: { ...f.values, cook_time: 200 } }, SMELTING, FIELDS));
    expect(back.cook_time, "back to the default: dropped").toBeUndefined();
  });

  it("keeps comments, alternatives and the file's layout", async () => {
    const text = `{
  // a comment
  type: "shaped",
  pattern: ["CI"],
  key: { C: ["@item:minecraft:iron_ingot", "@tag:item:c:iron_ingots"], I: "@item:minecraft:stick" },
  result: "@item:mymod:pick",
}`;
    const r = (await parseRecipe(text, SHAPED, FIELDS))!;
    expect(r.slots.grid.slice(0, 2)).toEqual(["minecraft:iron_ingot | #c:iron_ingots", "minecraft:stick"]);
    const out = await serializeRecipe(text, { ...r, count: 2 }, SHAPED, FIELDS);
    expect(out).toContain("// a comment");
    expect((await read(out)).count).toBe(2);
  });

  it("isn't a recipe", async () => {
    expect(await parseRecipe("[1]", SHAPED, FIELDS)).toBeNull();
    expect(await parseRecipe("{", SHAPED, FIELDS)).toBeNull();
    expect(await recipeType('{ type: "smelting" }', FIELDS)).toBe("smelting");
  });
});

describe("recipes of the mod's own kinds", () => {
  it("round-trips slots and values, in the kind's order", async () => {
    const text = '{ type: "mymod:crusher", values: { time: 40 }, slots: { extra: ["@item:minecraft:flint"], input: ["minecraft:gravel"] }, result: "minecraft:sand", count: 2 }';
    const r = (await parseRecipe(text, CRUSHER, FIELDS))!;
    expect(r.slots).toEqual({ input: ["minecraft:gravel"], extra: ["minecraft:flint"] });
    expect(r.values).toEqual({ time: 40 });
    const j = await read(serializeRecipe(text, r, CRUSHER, FIELDS));
    expect(Object.keys(j.slots as object)).toEqual(["input", "extra"]);
    expect(j).toMatchObject({ values: { time: 40 }, count: 2 });
  });
});

describe("switching kinds", () => {
  it("keeps the result and count, drops the old kind's fields", async () => {
    const text = '{ type: "smelting", ingredient: "minecraft:sand", cook_time: 100, result: "minecraft:glass", count: 3 }';
    const before = await parseRecipe(text, SMELTING, FIELDS);
    const j = await read(switchKind(text, before, CRUSHER, KINDS, FIELDS));
    expect(j).toMatchObject({ type: "mymod:crusher", result: "@item:minecraft:glass", count: 3, values: { time: 0 } });
    expect(j.ingredient).toBeUndefined();
    expect(j.cook_time).toBeUndefined();
  });
});
