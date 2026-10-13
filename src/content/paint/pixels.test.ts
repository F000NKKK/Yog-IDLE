import { describe, expect, it } from "vitest";
import { cloneImage, fill, getPixel, type PixelImage, type Rgba } from "./pixels";

/** The straightforward fill `fill` must agree with: per-pixel reads, a stack of points. */
function reference(img: PixelImage, x: number, y: number, c: Rgba, global: boolean, mirrorX = false) {
  const same = (p: Rgba, q: Rgba) => (p[3] === 0 && q[3] === 0) || p.every((v, i) => v === q[i]);
  const set = (px: number, py: number) => img.data.set(c, (py * img.w + px) * 4);
  const target = getPixel(img, x, y);
  if (!target || same(target, c)) return;
  if (global) {
    for (let py = 0; py < img.h; py++) for (let px = 0; px < img.w; px++) if (same(getPixel(img, px, py)!, target)) set(px, py);
    return;
  }
  const seen = new Set<number>();
  const stack: [number, number][] = [[x, y]];
  while (stack.length) {
    const [px, py] = stack.pop()!;
    if (px < 0 || py < 0 || px >= img.w || py >= img.h || seen.has(py * img.w + px)) continue;
    seen.add(py * img.w + px);
    if (!same(getPixel(img, px, py)!, target)) continue;
    set(px, py);
    stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
  }
  if (mirrorX) reference(img, img.w - 1 - x, y, c, false);
}

/** A noisy image from a few colors (two of them fully transparent but different RGB). */
function noise(w: number, h: number, seed: number): PixelImage {
  const palette: Rgba[] = [[0, 0, 0, 0], [9, 9, 9, 0], [255, 0, 0, 255], [0, 255, 0, 128]];
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    data.set(palette[(seed >> 16) % (i % 7 === 0 ? 4 : 2)], i * 4);
  }
  return { w, h, data };
}

describe("fill", () => {
  it("paints exactly what the reference fill paints", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const img = noise(17 + (seed % 5), 13 + (seed % 3), seed);
      const x = seed % img.w;
      const y = (seed * 7) % img.h;
      const color: Rgba = seed % 4 ? [12, 34, 56, 255] : [0, 0, 0, 0];
      for (const global of [false, true]) {
        for (const mirror of [false, true]) {
          const got = cloneImage(img);
          const want = cloneImage(img);
          fill(got, x, y, color, global, mirror);
          reference(want, x, y, color, global, mirror);
          expect(got.data).toEqual(want.data);
        }
      }
    }
  });

  it("ignores a point outside the image", () => {
    const img = noise(4, 4, 3);
    const before = cloneImage(img);
    fill(img, 4, 0, [1, 2, 3, 255], false);
    expect(img.data).toEqual(before.data);
  });
});
