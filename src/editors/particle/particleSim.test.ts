import { describe, expect, it } from "vitest";
import { type ParticleLook, frameAt, spawn, tick } from "./particleSim";

/** Hex's conjured particle, as `format.complete` gives it. */
const CONJURE: ParticleLook = {
  textures: ["hexcasting:particle/cloud"],
  frames: "age",
  frame_speed: 4,
  frame_settle: true,
  lifetime: { min: 64, max: 85 },
  size: 0.9,
  size_per_tick: 0.96,
  alpha: 0.3,
  fade: true,
  friction: 0.96,
  gravity: -0.01,
  gravity_needs_motion: true,
  physics: false,
  slide_when_blocked: true,
  random_roll: true,
  render: { blend: "additive", depth_write: false, glow: false },
};

const HALF = () => 0.5;

describe("a particle as the game runs it", () => {
  it("rises only when sprayed along every axis", () => {
    expect(spawn(CONJURE, [0, 0, 0], [0.1, 0.1, 0.1], 0xffffff, 1, HALF).gravity).toBe(-0.01);
    expect(spawn(CONJURE, [0, 0, 0], [0.1, 0, 0.1], 0xffffff, 1, HALF).gravity).toBe(0);
  });

  it("fades out and shrinks over its life, then goes", () => {
    const p = spawn(CONJURE, [0, 0, 0], [0.1, 0.1, 0.1], 0xffffff, 1, HALF);
    const size = p.quadSize;
    tick(CONJURE, p, 1, 0);
    expect(p.alpha).toBeLessThan(CONJURE.alpha);
    expect(p.quadSize).toBeCloseTo(size * CONJURE.size_per_tick);
    while (!p.removed) tick(CONJURE, p, 1, 0);
    expect(p.age).toBe(p.lifetime + 1);
  });

  it("settles its frames by its age once the fast run is past its life", () => {
    const p = spawn(CONJURE, [0, 0, 0], [0.1, 0.1, 0.1], 0xffffff, 5, HALF);
    p.age = p.lifetime / 2;
    expect(frameAt(CONJURE, p, 5)).toBe(Math.floor(((p.lifetime / 2) * 4) / p.lifetime));
    expect(frameAt({ ...CONJURE, frame_settle: false }, p, 5)).toBe(4);
  });

  it("stops on the ground with physics", () => {
    const look = { ...CONJURE, physics: true, gravity: 1, gravity_needs_motion: false };
    const p = spawn(look, [0, 0.05, 0], [0, -1, 0], 0xffffff, 1, HALF);
    for (let i = 0; i < 10; i++) tick(look, p, 1, 0);
    expect(p.y).toBe(0);
  });
});
