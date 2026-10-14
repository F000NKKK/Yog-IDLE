import { describe, expect, it } from "vitest";
import ydef from "./fixtures/ydef.shape.json";
import yblock from "./fixtures/yblock.shape.json";
import { setAt, shapeProperties, type Described } from "./shapeGrid";

// `yog schema ydef` / `yog schema yblock` — the build's own schemas.
const t = (s: string, p?: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(p?.[k] ?? ""));

describe("schema-driven property grids", () => {
  it("a tagged enum: its kind, then that kind's fields; switching keeps shared ones", () => {
    let value: Record<string, unknown> = { kind: "level", id: "mythril", ladder: "@ladder:minecraft:tool" };
    const rows = shapeProperties(ydef as unknown as Described, value, (v) => (value = v), t);
    expect(rows.map((r) => r.id)).toEqual(["kind", "id", "ladder", "above"]);
    expect(rows[0].options).toEqual(["ladder", "level", "sound_group"]);
    rows.find((r) => r.id === "above")!.onCommit!("@level:minecraft:diamond");
    expect(value.above).toBe("@level:minecraft:diamond");
    shapeProperties(ydef as unknown as Described, value, (v) => (value = v), t)[0].onCommit!("ladder");
    expect(value).toEqual({ kind: "ladder", id: "mythril" });
  });

  it("structs become categories, ranges are checked, plain lists are comma-separated", () => {
    let value: Record<string, unknown> = { model: { parent: "cube_all" }, block: { light: 4, tool: "pickaxe" } };
    const rows = shapeProperties(yblock as unknown as Described, value, (v) => (value = v), t);
    const light = rows.find((r) => r.id === "block.light")!;
    expect(light.category).toBe("Block");
    expect(light.value).toBe(4);
    expect(light.validate!("16")).toBe("0 to 15.");
    expect(light.validate!("15")).toBeNull();
    // An open vocabulary: the game's group by name or a mod's by reference.
    expect(rows.find((r) => r.id === "block.sound")!.kind).toBe("string");
    rows.find((r) => r.id === "block.connect_groups")!.onCommit!("mymod:pipe, mymod:cable");
    expect((value.block as Record<string, unknown>).connect_groups).toEqual(["mymod:pipe", "mymod:cable"]);
    // Removing the last value of a struct drops it.
    expect(setAt({ a: { b: 1 } }, ["a", "b"], undefined)).toEqual({});
    expect(rows.find((r) => r.id === "model.elements")!.readOnly).toBe(true);
  });
});
