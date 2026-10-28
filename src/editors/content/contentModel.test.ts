import { describe, expect, it } from "vitest";
import type { Model } from "../../content/model";
import { editModelElements, setParent } from "./contentModel";

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

describe("editing a model's elements", () => {
  const template = (): Model => ({ parent: "cube_all", textures: { all: "@texture:mymod:block/ruby" } });
  const shown = cube().elements!;

  it("a drag that moves nothing leaves the template and the parent", () => {
    const m = template();
    editModelElements(m, shown, {}, (els) => {
      els[0].from = [...els[0].from] as typeof els[0]["from"];
      els[0].to = [...els[0].to] as typeof els[0]["to"];
    });
    expect(m).toEqual(template());
  });

  it("a real move copies the elements in and the template goes", () => {
    const m = template();
    editModelElements(m, shown, {}, (els) => void (els[0].to = [16, 8, 16]));
    expect(m.parent).toBeUndefined();
    expect(m.elements?.[0].to).toEqual([16, 8, 16]);
    expect(m.textures).toEqual({ all: "@texture:mymod:block/ruby" });
  });

  it("a parent model's textures come along when its elements are copied", () => {
    const m: Model = { parent: "mymod:block/base" };
    const parents = { "mymod:block/base": { textures: { side: "@texture:mymod:block/side" }, elements: shown } };
    editModelElements(m, shown, parents, (els) => void els.pop());
    expect(m.parent).toBeUndefined();
    expect(m.textures).toEqual({ side: "@texture:mymod:block/side" });
    expect(m.elements).toEqual([]);
  });

  it("a model with its own elements is edited in place", () => {
    const m = cube();
    editModelElements(m, [], {}, (els) => void (els[0].name = "core"));
    expect(m.elements?.[0].name).toBe("core");
  });
});
