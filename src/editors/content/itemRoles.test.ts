import { describe, expect, it } from "vitest";
import type { ItemProps } from "../../content/model";
import { setArmorSlot, setDurability, setToolKind, setWearable } from "./itemRoles";

describe("what an item is, kept one the build takes", () => {
  it("a tool is no longer armor", () => {
    const x: ItemProps = { armor: { slot: "head", material: "iron" } };
    setToolKind(x, "pickaxe");
    expect(x.tool).toEqual({ material: "iron", kind: "pickaxe" });
    expect(x.armor).toBeUndefined();
  });

  it("armor is no longer a tool, and is worn already", () => {
    const x: ItemProps = { tool: { kind: "axe", material: "gold" }, wearable: "head" };
    setArmorSlot(x, "chest");
    expect(x.armor).toEqual({ material: "iron", slot: "chest" });
    expect(x.tool).toBeUndefined();
    expect(x.wearable).toBeUndefined();
  });

  it("worn without being armor is no longer armor", () => {
    const x: ItemProps = { armor: { slot: "head", material: "iron" } };
    setWearable(x, "head");
    expect(x.wearable).toBe("head");
    expect(x.armor).toBeUndefined();
  });

  it("a durable item stacks to 1: its stack size goes", () => {
    const x: ItemProps = { stack_size: 16 };
    setDurability(x, 250);
    expect(x.durability).toBe(250);
    expect(x.stack_size).toBeUndefined();
  });

  it("clearing a role clears it alone", () => {
    const x: ItemProps = { tool: { kind: "axe", material: "iron" }, wearable: "head", durability: 9 };
    setToolKind(x, undefined);
    setWearable(x, undefined);
    setDurability(x, undefined);
    expect(x).toEqual({});
  });
});
