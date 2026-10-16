import { describe, expect, it } from "vitest";
import {
  allStates,
  defaultState,
  moveVariant,
  newVariantKey,
  propertyKind,
  propertyNameProblem,
  rangeValues,
  removeModel,
  removeProperty,
  renameModel,
  renameProperty,
  setVariantKey,
  stateCount,
  stateProperties,
  statesShowing,
  turn,
  valuesProblem,
  variantKey,
  variantOf,
  variantProblems,
  type States,
} from "./states";
import type { BlockProps } from "./model";

// HexMod's impetus: facing all, one yes/no of its own, a model per value.
const impetus = (): States => ({
  facing: "all",
  placement: "away",
  properties: { energized: ["false", "true"] },
  models: { dim: { parent: "cube" }, lit: { parent: "cube" } },
  variants: { "energized=false": "dim", "energized=true": "lit" },
});

describe("block states", () => {
  it("lists the host's properties before the block's own", () => {
    const props = stateProperties({ attach: true, waterlogged: true, properties: { level: ["0", "1", "2"] } });
    expect(props.map((p) => [p.name, p.values.length, p.own])).toEqual([
      ["facing", 4, false],
      ["face", 3, false],
      ["waterlogged", 2, false],
      ["level", 3, true],
    ]);
    expect(stateCount(props)).toBe(72);
    expect(defaultState(props)).toEqual({ facing: "north", face: "floor", waterlogged: "false", level: "0" });
  });

  it("tells yes/no, number ranges and names apart", () => {
    expect(propertyKind(["false", "true"])).toBe("bool");
    expect(propertyKind(["true", "false"])).toBe("bool");
    expect(propertyKind(["0", "1", "2", "3"])).toBe("range");
    expect(propertyKind(["2", "0", "1"])).toBe("range");
    expect(propertyKind(["0", "2"])).toBe("values");
    expect(propertyKind(["01", "2"])).toBe("values");
    expect(propertyKind(["dim", "lit"])).toBe("values");
    expect(rangeValues(1, 4, "3")).toEqual(["3", "1", "2", "4"]);
  });

  it("checks names and values as the build does", () => {
    expect(valuesProblem(["a"])).not.toBeNull();
    expect(valuesProblem(["a", "a"])).not.toBeNull();
    expect(valuesProblem(["a", "B"])).not.toBeNull();
    expect(valuesProblem(["a", "b_2"])).toBeNull();
    expect(propertyNameProblem("facing", [])).not.toBeNull();
    expect(propertyNameProblem("lit", ["lit"])).not.toBeNull();
    expect(propertyNameProblem("Lit", [])).not.toBeNull();
    expect(propertyNameProblem("lit", ["energized"])).toBeNull();
  });

  it("shows the first variant that matches, turned by facing", () => {
    const s = impetus();
    expect(variantOf(s, { facing: "up", energized: "true" })).toEqual({ key: "energized=true", models: ["lit"], x: 270, y: 0 });
    expect(variantOf(s, { facing: "west", energized: "false" })).toMatchObject({ models: ["dim"], x: 0, y: 270 });
    expect(variantOf({ variants: {} }, {})).toEqual({ key: null, models: [], x: 0, y: 0 });
    expect(turn("east", "ceiling")).toEqual({ x: 180, y: 270 });
    expect(turn("south", "wall")).toEqual({ x: 90, y: 180 });
    expect(statesShowing(s, "energized=true")).toBe(6);
  });

  it("goes through every state, the last property fastest", () => {
    const props = stateProperties({ properties: { a: ["x", "y"], b: ["0", "1", "2"] } });
    expect([...allStates(props)].map((st) => `${st.a}${st.b}`)).toEqual(["x0", "x1", "x2", "y0", "y1", "y2"]);
    expect([...allStates(props, 2)]).toHaveLength(2);
  });

  it("flags variants with unknown properties, values or models", () => {
    const s = impetus();
    s.variants!["energized=maybe"] = "gone";
    expect(variantProblems(s, "energized=true")).toEqual([]);
    expect(variantProblems(s, "energized=maybe").map((p) => p.message)).toEqual(["{pair}: no such property and value", "{name}: not in the state models"]);
  });

  it("renames a property in its variants and the block's references", () => {
    const s = impetus();
    const block: BlockProps = { comparator: "energized" };
    renameProperty(s, block, "energized", "lit_up");
    expect(Object.keys(s.properties!)).toEqual(["lit_up"]);
    expect(Object.keys(s.variants!)).toEqual(["lit_up=false", "lit_up=true"]);
    expect(block.comparator).toBe("lit_up");
  });

  it("removes a property with the variants that need it", () => {
    const s = impetus();
    s.variants!["facing=up"] = "lit";
    const block: BlockProps = { powered: "energized" };
    removeProperty(s, block, "energized");
    expect(s.properties).toBeUndefined();
    expect(s.variants).toEqual({ "facing=up": "lit" });
    expect(block.powered).toBeUndefined();
  });

  it("renames and removes state models in the variants", () => {
    const s = impetus();
    s.variants!["facing=up"] = ["dim", "lit"];
    renameModel(s, "lit", "on");
    expect(Object.keys(s.models!)).toEqual(["dim", "on"]);
    expect(s.variants).toEqual({ "energized=false": "dim", "energized=true": "on", "facing=up": ["dim", "on"] });
    removeModel(s, "dim");
    expect(s.variants).toEqual({ "energized=true": "on", "facing=up": "on" });
  });

  it("reorders variants and edits their conditions in place", () => {
    const s = impetus();
    moveVariant(s, "energized=true", -1);
    expect(Object.keys(s.variants!)).toEqual(["energized=true", "energized=false"]);
    expect(setVariantKey(s, "energized=true", "energized=false")).toBe(false);
    expect(setVariantKey(s, "energized=true", "energized=true,facing=up")).toBe(true);
    expect(Object.keys(s.variants!)).toEqual(["energized=true,facing=up", "energized=false"]);
    const props = stateProperties(s);
    expect(variantKey({ energized: "true", facing: "down" }, props)).toBe("facing=down,energized=true");
    expect(newVariantKey(s)).toBe("facing=north");
  });
});
