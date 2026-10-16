import { describe, expect, it } from "vitest";
import { customFrom, emptyRecipe, parseCustomRecipe, parseRecipe, serializeCustomRecipe, serializeRecipe, slotCell, type RecipeKind } from "./recipeModel";

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
    expect(j.key).toEqual({ I: "@item:minecraft:iron_ingot", S: "@item:minecraft:stick" });
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
    expect(JSON.parse(serializeRecipe(s))).toMatchObject({ ingredients: ["@item:minecraft:paper", "@tag:item:c:dusts"], count: 2 });
    const f = parseRecipe(JSON.stringify({ type: "smelting", ingredient: "minecraft:sand", result: "minecraft:glass", cook_time: 100 }))!;
    expect(f.cells[0]).toBe("minecraft:sand");
    const j = JSON.parse(serializeRecipe(f));
    expect(j).toMatchObject({ ingredient: "@item:minecraft:sand", cook_time: 100 });
    expect(j.experience).toBeUndefined();
  });

  it("isn't a recipe", () => {
    expect(parseRecipe("[1]")).toBeNull();
    expect(parseRecipe("{")).toBeNull();
    expect(parseRecipe('{ type: "not_a_recipe" }'), "another kind: edited as code, never overwritten").toBeNull();
  });

  it("reads and writes Yog Data references, alternatives kept", () => {
    const r = parseRecipe(`{
      // a comment
      type: "shaped", pattern: ["CI"],
      key: { C: ["@item:minecraft:iron_ingot", "@tag:item:c:iron_ingots"], I: "@item:minecraft:stick" },
      result: "@item:mymod:pick",
    }`)!;
    expect(r.cells.slice(0, 2)).toEqual(["minecraft:iron_ingot | #c:iron_ingots", "minecraft:stick"]);
    expect(r.result).toBe("mymod:pick");
    const j = JSON.parse(serializeRecipe(r));
    expect(j.key).toEqual({ I: ["@item:minecraft:iron_ingot", "@tag:item:c:iron_ingots"], S: "@item:minecraft:stick" });
    expect(j.result).toBe("@item:mymod:pick");
  });
});

describe("recipes of the mod's own kinds", () => {
  const kind: RecipeKind = {
    id: "mymod:crusher",
    file: "",
    slots: [{ name: "input", max: 1, required: true }, { name: "extra", max: 2, required: false }],
    values: [{ name: "time", kind: "number" }],
    layout: null,
  };

  it("reads and writes slots, values, result and count", () => {
    const text = `{ type: "mymod:crusher", slots: { extra: ["@tag:item:c:dusts"], input: [["@item:minecraft:coal", "@item:minecraft:charcoal"]] },
      values: { time: 200 }, result: "@item:minecraft:gravel", count: 2, id: "x" }`;
    const r = parseCustomRecipe(text)!;
    expect(r.slots.input).toEqual(["minecraft:coal | minecraft:charcoal"]);
    expect(r.slots.extra).toEqual(["#c:dusts"]);
    expect(r.values.time).toBe(200);
    const back = JSON.parse(serializeCustomRecipe(r, kind));
    expect(Object.keys(back.slots)).toEqual(["input", "extra"]);
    expect(back.slots.input).toEqual([["@item:minecraft:coal", "@item:minecraft:charcoal"]]);
    expect(back).toMatchObject({ type: "mymod:crusher", values: { time: 200 }, result: "@item:minecraft:gravel", count: 2, id: "x" });
    expect(parseRecipe(text)).toBeNull();
    expect(parseCustomRecipe(`{ type: "shaped" }`)).toBeNull();
  });

  it("starts a recipe of a kind from another's result", () => {
    const r = customFrom(kind, { result: "minecraft:stone", count: 3 });
    expect(r).toMatchObject({ type: "mymod:crusher", values: { time: 0 }, result: "minecraft:stone", count: 3 });
  });
});

describe("the game's single-input kinds", () => {
  it("reads and writes stonecutting and every cooking kind", () => {
    const cut = parseRecipe('{ "type": "stonecutting", "ingredient": "@tag:item:hexcasting:amethyst_blocks", "result": "@item:hexcasting:amethyst_bricks", "count": 2 }')!;
    expect([cut.type, cut.cells[0], cut.result, cut.count]).toEqual(["stonecutting", "#hexcasting:amethyst_blocks", "hexcasting:amethyst_bricks", 2]);
    expect(parseRecipe(serializeRecipe(cut))).toEqual(cut);
    const blast = parseRecipe('{ "type": "blasting", "ingredient": "@item:minecraft:iron_ore", "result": "@item:minecraft:iron_ingot" }')!;
    // Its own default time, not a furnace's — and not written back.
    expect(blast.cookTime).toBe(100);
    expect(serializeRecipe(blast)).not.toContain("cook_time");
  });

  it("reads and writes brewing with stable potion references", () => {
    const r = parseRecipe(`{
      type: "brewing",
      from: "@potion:yog:awkward",
      ingredient: "@item:hexcasting:amethyst_dust",
      result: "@potion:hexcasting:enlarge_grid",
    }`)!;
    expect([r.from, r.cells[0], r.result]).toEqual(["yog:awkward", "hexcasting:amethyst_dust", "hexcasting:enlarge_grid"]);
    expect(JSON.parse(serializeRecipe(r))).toMatchObject({
      type: "brewing",
      from: "@potion:yog:awkward",
      ingredient: "@item:hexcasting:amethyst_dust",
      result: "@potion:hexcasting:enlarge_grid",
    });
    expect(parseRecipe(serializeRecipe(r))).toEqual(r);
  });
});

describe("smithing", () => {
  const text = `{
    type: "smithing",
    template: "@item:minecraft:netherite_upgrade_smithing_template",
    base: "@item:minecraft:diamond_sword",
    addition: ["@item:minecraft:netherite_ingot", "@tag:item:c:ingots/netherite"],
    result: "@item:minecraft:netherite_sword",
    id: "mymod:netherite_sword", group: "netherite", category: "equipment", requires: ["pehkui"],
  }`;

  it("reads template, base and addition into their cells, every other field kept", () => {
    const r = parseRecipe(text)!;
    expect(r.type).toBe("smithing");
    expect(r.cells.slice(0, 3)).toEqual(["minecraft:netherite_upgrade_smithing_template", "minecraft:diamond_sword", "minecraft:netherite_ingot | #c:ingots/netherite"]);
    expect(r.result).toBe("minecraft:netherite_sword");
    const j = JSON.parse(serializeRecipe(r));
    expect(j).toEqual({
      id: "mymod:netherite_sword",
      group: "netherite",
      category: "equipment",
      requires: ["pehkui"],
      type: "smithing",
      template: "@item:minecraft:netherite_upgrade_smithing_template",
      base: "@item:minecraft:diamond_sword",
      addition: ["@item:minecraft:netherite_ingot", "@tag:item:c:ingots/netherite"],
      result: "@item:minecraft:netherite_sword",
    });
    expect(parseRecipe(serializeRecipe(r))).toEqual(r);
  });

  it("an edited part, a count and an emptied part go back to the file", () => {
    const r = parseRecipe(text)!;
    r.cells[slotCell("base", 0)] = "minecraft:diamond_axe";
    r.cells[slotCell("template", 0)] = null;
    r.count = 2;
    const j = JSON.parse(serializeRecipe(r));
    expect(j).toMatchObject({ template: "", base: "@item:minecraft:diamond_axe", count: 2 });
    expect(j.ingredient).toBeUndefined();
    expect(j.experience).toBeUndefined();
  });

  it("a new one from another kind keeps the result and starts empty", () => {
    const r = { ...emptyRecipe(), type: "smithing" as const, result: "mymod:ruby_sword" };
    const j = JSON.parse(serializeRecipe(r));
    expect(j).toEqual({ type: "smithing", template: "", base: "", addition: "", result: "@item:mymod:ruby_sword" });
    expect(j.pattern).toBeUndefined();
  });

  it("maps the game kinds' slots to cells", () => {
    expect([slotCell("template", 0), slotCell("base", 0), slotCell("addition", 0)]).toEqual([0, 1, 2]);
    expect([slotCell("grid", 4), slotCell("input", 0)]).toEqual([4, 0]);
  });
});
