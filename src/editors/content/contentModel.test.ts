import { describe, expect, it } from "vitest";
import type { Model } from "../../content/model";
import { setParent } from "./contentModel";

const cube = (): Model => ({
  textures: { all: "@texture:mymod:block/ruby" },
  elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: "#all" } } }],
});

describe("a model's parent", () => {
  it("a template takes the place of the model's own elements", () => {
    const m = cube();
    setParent(m, "cube_all");
    expect(m.parent).toBe("cube_all");
    expect(m.elements).toBeUndefined();
    expect(m.textures).toEqual({ all: "@texture:mymod:block/ruby" });
  });

  it("a model by id keeps them (they replace its shape)", () => {
    const m = cube();
    setParent(m, "minecraft:block/block");
    expect(m.parent).toBe("minecraft:block/block");
    expect(m.elements).toHaveLength(1);
  });

  it("empty is none: the model's own elements", () => {
    const m: Model = { parent: "cube_all" };
    setParent(m, "  ");
    expect(m.parent).toBeUndefined();
  });
});
