import { describe, expect, it } from "vitest";
import { addImageFrame, cropFrame, entryAt, frameCount, frameRect, msToNextFrame, pasteFrame, type TextureAnimation } from "./animation";
import { blankImage } from "./paint/pixels";

const strip = (frames: number) => {
  const img = blankImage(2, 2 * frames);
  // Each frame's first pixel's red is its number.
  for (let f = 0; f < frames; f++) img.data[f * 2 * 2 * 4] = f + 1;
  return img;
};
const anim: TextureAnimation = { frameWidth: 2, frameHeight: 2, frames: [{ index: 0, time: 10 }, { index: 2, time: 2 }, { index: 1, time: 1 }], interpolate: false };

describe("texture animation", () => {
  it("lays frames row by row", () => {
    expect(frameCount(anim, 2, 6)).toBe(3);
    expect(frameRect(anim, 2, 2)).toEqual([0, 4, 2, 2]);
    expect(frameRect(anim, 4, 3)).toEqual([2, 2, 2, 2]);
  });

  it("plays each step for its ticks, looping", () => {
    expect([0, 9, 10, 11, 12, 13].map((t) => entryAt(anim, t))).toEqual([0, 0, 1, 1, 2, 0]);
    // 20 ticks a second: tick 9.5 is 475 ms; step 1 starts at tick 10.
    expect(msToNextFrame(anim, 475)).toBeCloseTo(25);
  });

  it("paints one frame and grows by copies", () => {
    const img = strip(3);
    expect(cropFrame(img, anim, 2).data[0]).toBe(3);
    const f = cropFrame(img, anim, 0);
    f.data[0] = 99;
    const pasted = pasteFrame(img, anim, 1, f);
    expect([pasted.data[0], pasted.data[16], pasted.data[32]]).toEqual([1, 99, 3]);
    const { img: grown, index } = addImageFrame(img, anim, 2);
    expect([grown.h, index, grown.data[48]]).toEqual([8, 3, 3]);
  });
});
