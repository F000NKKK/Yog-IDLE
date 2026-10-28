import { describe, expect, it } from "vitest";
import type { States } from "../../content/states";
import { setAttach, setFacing, setPlacement, setWaterlogged } from "./stateRoles";

describe("a block's placement", () => {
  it("turning drops random rotations and connecting", () => {
    const s = { rotations: [{ y: 90 }], connect: { arm: {} } } as unknown as States;
    setFacing(s, "horizontal");
    expect(s.rotations).toBeUndefined();
    expect(s.connect).toBeUndefined();
  });

  it("placement goes with the last of facing and attach", () => {
    const s = {} as States;
    setPlacement(s, "away");
    expect(s.placement).toBeUndefined();
    setFacing(s, "horizontal");
    setPlacement(s, "away");
    setAttach(s, true);
    setFacing(s, undefined);
    expect(s.placement).toBe("away");
    setAttach(s, false);
    expect(s.placement).toBeUndefined();
  });

  it("attaching and facing all six sides exclude each other", () => {
    const s = {} as States;
    setFacing(s, "all");
    setAttach(s, true);
    expect(s.facing).toBeUndefined();
    setFacing(s, "all");
    expect(s.attach).toBeUndefined();
    setWaterlogged(s, true);
    setWaterlogged(s, false);
    expect(s.waterlogged).toBeUndefined();
  });
});
