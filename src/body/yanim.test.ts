import { describe, expect, it } from "vitest";
import { addClip, cloneDoc, moveKey, parseAnim, patchAnim, removeKey, renameClip, samplePose, setClipField, setKey, type Clip } from "./yanim";

const FILE = `// Wings.
{
  "flap": {
    "length": 1,
    "loop": "loop",
    "bones": {
      "left_wing": {
        // Up and down.
        "rotation": {
          "0": [0, 0, 0],
          "0.5": { "value": [0, 0, 40], "ease": "smooth" },
          "1": [0, 0, 0]
        }
      }
    }
  }
}
`;

const parsed = async () => {
  const p = await parseAnim(FILE);
  if (!p.ok) throw new Error(p.error);
  return p;
};

describe("yanim", () => {
  it("reads clips, keys in time order", async () => {
    const { clips } = await parsed();
    expect(clips.map((c) => c.name)).toEqual(["flap"]);
    const keys = clips[0].bones[0].tracks.rotation;
    expect(keys.map((k) => k.at)).toEqual(["0", "0.5", "1"]);
    expect(keys[1]).toMatchObject({ value: [0, 0, 40], ease: "smooth" });
    expect(clips[0].loop).toBe("loop");
  });

  it("writes back what changed, comments and spelling kept", async () => {
    const { doc } = await parsed();
    expect(await patchAnim(FILE, doc)).toBe(FILE);
    const next = cloneDoc(doc);
    setKey(next, "flap", "left_wing", "rotation", 0.5, [0, 0, 60], "smooth");
    expect(await patchAnim(FILE, next)).toBe(FILE.replace("[0, 0, 40]", "[0, 0, 60]"));
  });

  it("adds a key between others, moves and removes keys", async () => {
    const { doc } = await parsed();
    const next = cloneDoc(doc);
    setKey(next, "flap", "left_wing", "rotation", 0.25, [0, 0, 20], "linear");
    const out = await patchAnim(FILE, next);
    expect(out.indexOf('"0.25"')).toBeLessThan(out.indexOf('"0.5"'));
    expect(out).toContain("// Up and down.");
    moveKey(next, "flap", "left_wing", "rotation", "0.25", 0.75);
    const moved = await parseAnim(await patchAnim(FILE, next));
    expect(moved.ok && moved.clips[0].bones[0].tracks.rotation.map((k) => k.at)).toEqual(["0", "0.5", "0.75", "1"]);
    removeKey(next, "flap", "left_wing", "rotation", "0.75");
    expect(await patchAnim(FILE, next)).toBe(FILE);
  });

  it("adds, renames clips and sets their loop", async () => {
    const { doc } = await parsed();
    const next = cloneDoc(doc);
    addClip(next, "idle", 2);
    renameClip(next, "flap", "fly");
    setClipField(next, "fly", "loop", "once");
    const p = await parseAnim(await patchAnim(FILE, next));
    expect(p.ok && p.clips.map((c) => [c.name, c.loop, c.length])).toEqual([
      ["fly", "once", 1],
      ["idle", "loop", 2],
    ]);
  });

  it("samples as yog-body does", () => {
    const clip = (ease: "linear" | "step" | "smooth", loop: Clip["loop"] = "once"): Clip => ({
      name: "swing",
      length: 1,
      loop,
      bones: [
        {
          bone: "arm",
          tracks: {
            rotation: [
              { time: 0, at: "0", value: [0, 0, 0], ease },
              { time: 1, at: "1", value: [90, 0, 0], ease },
            ],
            position: [],
            scale: [],
          },
        },
      ],
    });
    expect(samplePose(clip("linear"), 0.5).arm.rotation[0]).toBeCloseTo(Math.PI / 4);
    expect(samplePose(clip("step"), 0.5).arm.rotation[0]).toBe(0);
    expect(samplePose(clip("smooth"), 1).arm.rotation[0]).toBeCloseTo(Math.PI / 2);
    expect(samplePose(clip("linear", "loop"), 1.5).arm.rotation[0]).toBeCloseTo(Math.PI / 4);
    expect(samplePose(clip("linear"), 1.5)).toEqual({});
    expect(samplePose(clip("linear", "hold"), 1.5).arm.rotation[0]).toBeCloseTo(Math.PI / 2);
    expect(samplePose(clip("linear"), 0.5).arm.scale).toEqual([1, 1, 1]);
  });
});
