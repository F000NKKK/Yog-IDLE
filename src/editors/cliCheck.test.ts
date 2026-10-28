/**
 * What the editors write, checked by the CLI as the IDE's live check does:
 * a new file, and a file after each edit an editor makes, must have no problem.
 */
import { describe, expect, it } from "vitest";
import { TEMPLATES, type ContentFile, type Model } from "../content/model";
import { cliProblems, haveCli } from "../test/cliCheck";
import { editModelElements, setParent } from "./content/contentModel";
import { setArmorSlot, setDurability, setToolKind, setWearable } from "./content/itemRoles";
import { newPage, PAGE_TYPES } from "./book/bookModel";
import { switchedTo, withRecipe, type Recipe, type RecipeFields, type RecipeKind } from "./recipe/recipeModel";
import { ITEM_TEMPLATES, templateFiles } from "../panels/NewItemDialog";

// The game's recipe kinds as `recipe_kinds` sends them (src-tauri/src/recipe_kinds.rs).
const FIELDS: RecipeFields = { type: "type", result: "result", count: "count", slots: "slots", values: "values", pattern: "pattern", key: "key", gridSide: 3 };
const one = (name: string, field = name) => ({ name, max: 1, required: true, field, grid: false });
const game = (id: string, slots: RecipeKind["slots"], values: RecipeKind["values"] = []): RecipeKind => ({ id, file: "", slots, values, layout: null });
const COOKING_VALUES: RecipeKind["values"] = [
  { name: "cook_time", kind: "number", default: 200 },
  { name: "experience", kind: "number", default: 0.1 },
];
const KINDS: RecipeKind[] = [
  game("shaped", [{ name: "grid", max: 9, required: true, grid: true }]),
  game("shapeless", [{ name: "grid", max: 9, required: true, field: "ingredients", grid: false }]),
  game("smelting", [one("input", "ingredient")], COOKING_VALUES),
  game("stonecutting", [one("input", "ingredient")]),
  game("smithing", [one("template"), one("base"), one("addition")]),
  game("brewing", [one("from"), one("input", "ingredient")]),
];
const STONE = "minecraft:stone";
/** Every place of `kind`'s slots filled. */
const filled = (r: Recipe, kind: RecipeKind): Recipe => ({ ...r, slots: Object.fromEntries(kind.slots.map((s) => [s.name, [STONE]])) });

const TEXTURE = "@texture:minecraft:block/stone";
const block = (model: Model): ContentFile => ({ name: "X", model });
const texturesFor = (slots: readonly string[]) => Object.fromEntries(slots.map((s) => [s, TEXTURE]));
const box = () => ({ from: [0, 0, 0], to: [16, 16, 16], faces: { north: { texture: "#all" } } });

describe.skipIf(!haveCli)("editors' files pass the CLI's check", () => {
  it("a block model set to each template keeps no elements of its own", () => {
    for (const t of TEMPLATES.filter((x) => !x.sprite)) {
      const m: Model = { elements: [box()], textures: texturesFor(t.slots) } as Model;
      setParent(m, t.name);
      expect(cliProblems("x.yblock", block(m)), t.name).toEqual([]);
    }
  });

  it("moving a template's element keeps the model valid", () => {
    const m: Model = { parent: "cube_all", textures: { all: TEXTURE } } as Model;
    editModelElements(m, [box()] as Model["elements"] & object, {}, (els) => void (els[0].from = [1, 0, 0]));
    expect(cliProblems("x.yblock", block(m))).toEqual([]);
  });

  it("an item's role changes leave no fields that don't go together", () => {
    const model = { parent: "generated", textures: { layer0: "@texture:minecraft:item/apple" } };
    const item: Record<string, unknown> = { stack_size: 64 };
    const steps: [string, () => void][] = [
      ["tool", () => setToolKind(item as never, "pickaxe")],
      ["armor", () => setArmorSlot(item as never, "head")],
      ["wearable", () => setWearable(item as never, "head")],
      ["durability", () => setDurability(item as never, 100)],
      ["tool again", () => setToolKind(item as never, "sword")],
    ];
    for (const [name, step] of steps) {
      step();
      expect(cliProblems("x.yitem", { name: "X", model, item }), name).toEqual([]);
    }
  });

  it("a book page of each type is valid as added", () => {
    const found: string[] = [];
    for (const p of PAGE_TYPES) {
      const book = {
        id: "mymod:guide",
        name: "Guide",
        categories: [{ id: "basics", name: "Basics" }],
        entries: [{ id: "welcome", name: "Welcome", category: "@category:basics", pages: [newPage(p.type)] }],
      };
      found.push(...cliProblems("x.ybook", book).map((m) => `${p.type}: ${m}`));
    }
    expect(found).toEqual([]);
  });

  it("a recipe switched to each kind and filled in is valid", () => {
    const found: string[] = [];
    for (const from of KINDS) {
      const start = withRecipe({ category: "misc" }, filled({ type: from.id, slots: {}, values: {}, result: STONE, count: 4 }, from), from, FIELDS);
      for (const to of KINDS) {
        const switched = switchedTo(start, { type: from.id, slots: {}, values: {}, result: STONE, count: 4 }, to, KINDS, FIELDS);
        const recipe = withRecipe(switched, filled({ type: to.id, slots: {}, values: {}, result: STONE, count: 4 }, to), to, FIELDS);
        found.push(...cliProblems("x.yrecipe", recipe).map((m) => `${from.id} → ${to.id}: ${m}`));
      }
    }
    expect(found).toEqual([]);
  });

  it("every new file of a Yog format is valid as made", async () => {
    const found: string[] = [];
    let checked = 0;
    for (const t of ITEM_TEMPLATES) {
      for (const [name, text] of templateFiles(t, "thing", { modId: "mymod" })) {
        if (!/\.y[a-z]+$/.test(name) || /\.(yui|ys|yns)$/.test(name)) continue;
        found.push(...cliProblems(name.split("/").pop()!, await text).map((m) => `${t.id} ${name}: ${m}`));
        checked++;
      }
    }
    expect(found).toEqual([]);
    expect(checked).toBeGreaterThan(4);
  });
});
