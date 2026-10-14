import { describe, expect, it } from "vitest";
import { parseRecipe, serializeRecipe } from "./recipeModel";

describe("recipeModel", () => {
  it("reads a shaped pattern into the grid and writes it back trimmed", () => {
    const r = parseRecipe(
      JSON.stringify({ type: "shaped", pattern: ["ISI", " S "], key: { I: "minecraft:iron_ingot", S: "minecraft:stick" }, result: "mymod:pick", id: "mymod:x" })
    )!;
    expect(r.cells).toEqual(["minecraft:iron_ingot", "minecraft:stick", "minecraft:iron_ingot", null, "minecraft:stick", null, null, null, null]);
    // Moved to the bottom-right corner: the empty edges go away again.
    const moved = { ...r, cells: [null, null, null, null, ...r.cells.slice(0, 2), null, ...r.cells.slice(4, 5), null] };
    const j = JSON.parse(serializeRecipe(moved));
    expect(j.pattern).toEqual(["IS", "S "]);
    expect(j.key).toEqual({ I: "minecraft:iron_ingot", S: "minecraft:stick" });
    expect(j.id).toBe("mymod:x");
    expect(j.count).toBeUndefined();
  });

  it("picks distinct letters", () => {
    const r = parseRecipe(JSON.stringify({ type: "shaped", pattern: [], key: {}, result: "a:b" }))!;
    r.cells = ["minecraft:stone", "minecraft:stick", "minecraft:string", null, null, null, null, null, null];
    const j = JSON.parse(serializeRecipe(r));
    expect(new Set(j.pattern[0]).size).toBe(3);
    expect(Object.keys(j.key)).toHaveLength(3);
  });

  it("shapeless and smelting", () => {
    const s = parseRecipe(JSON.stringify({ type: "shapeless", ingredients: ["minecraft:paper", "#c:dusts"], result: "a:b", count: 2 }))!;
    expect(s.cells.slice(0, 3)).toEqual(["minecraft:paper", "#c:dusts", null]);
    expect(JSON.parse(serializeRecipe(s))).toMatchObject({ ingredients: ["minecraft:paper", "#c:dusts"], count: 2 });
    const f = parseRecipe(JSON.stringify({ type: "smelting", ingredient: "minecraft:sand", result: "minecraft:glass", cook_time: 100 }))!;
    expect(f.cells[0]).toBe("minecraft:sand");
    const j = JSON.parse(serializeRecipe(f));
    expect(j).toMatchObject({ ingredient: "minecraft:sand", cook_time: 100 });
    expect(j.experience).toBeUndefined();
  });

  it("isn't a recipe", () => {
    expect(parseRecipe("[1]")).toBeNull();
    expect(parseRecipe("{")).toBeNull();
  });
});
