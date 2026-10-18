import { readFile, editData } from "../test/data";
import { describe, expect, it } from "vitest";
import { cubeQuads, mirroredBone, modelOf, ordered, rawOf, type Cube } from "./ymodel";

const wing: Cube = { origin: [-10, 0, 0], size: [10, 20, 2], uv: [22, 0], inflate: 1, mirror: false };

describe("ymodel", () => {
  it("bakes a cube as yog-body does", () => {
    const q = cubeQuads(wing, 64, 32);
    // DOWN: v4, v3, v7, v0 with UVs from (d, 0) to (d + w, d).
    expect(q[0].pos[0]).toEqual([1, -1, 3]);
    expect(q[0].uv[0]).toEqual([34 / 64, 0]);
    expect(q[0].uv[1]).toEqual([24 / 64, 0]);
    expect(q[3].normal).toEqual([0, 0, -1]);
    const m = cubeQuads({ ...wing, mirror: true }, 64, 32);
    expect(m[2].normal).toEqual([1, 0, 0]);
    expect(m[0].pos[3]).toEqual([-11, -1, 3]);
  });

  it("reads and writes back, comments kept", async () => {
    const text = `// a comment
{ texture: "misc/a.png", texture_size: [64, 32], bones: [
  { name: "body", pivot: [0, 24, 0], cubes: [{ origin: [-4, 0, -2], size: [8, 12, 4], uv: [16, 16] }] },
  { name: "wing", parent: "body", rotation: [15, 0, -15], locators: { tip: [1, 2, 3] } } ] }`;
    const m = modelOf(await readFile(text));
    expect(m.bones[1].parent).toBe("body");
    const out = await editData(text, () => {});
    expect(out).toBe(text);
    expect(modelOf(rawOf(m))).toEqual(m);
  });

  it("puts parents first and mirrors sides", () => {
    const m = modelOf({ texture: "", bones: [{ name: "left_arm", parent: "body", pivot: [5, 2, 0] }, { name: "body" }] });
    expect(ordered(m).map((b) => b.name)).toEqual(["body", "left_arm"]);
    const r = mirroredBone(m, m.bones[0]);
    expect(r.name).toBe("right_arm");
    expect(r.pivot).toEqual([-5, 2, 0]);
  });
});
