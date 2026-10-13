// "Convert to 3D elements": an item sprite (layer textures extruded 1px
// thick, as Minecraft's `item/generated` draws it) as model elements of its
// own, so it can be edited like any element model. Opaque pixels are merged
// into rectangles (greedy: widest run, then down while the run stays
// opaque) — one element per rectangle keeps the element count low.

import type { PixelImage } from "./paint/pixels";
import type { Element, Uv } from "./model";

const ALPHA = 25;

/** Opaque pixels of the image (its first frame) as rectangles `[x, y, w, h]`. */
export function opaqueRects(img: PixelImage, frameHeight = img.h): [number, number, number, number][] {
  const { w } = img;
  const h = Math.min(frameHeight, img.h);
  const opaque = (x: number, y: number) => img.data[(y * w + x) * 4 + 3] > ALPHA;
  const used = new Uint8Array(w * h);
  const out: [number, number, number, number][] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (used[y * w + x] || !opaque(x, y)) continue;
      let rw = 1;
      while (x + rw < w && !used[y * w + x + rw] && opaque(x + rw, y)) rw++;
      let rh = 1;
      grow: while (y + rh < h) {
        for (let i = 0; i < rw; i++) if (used[(y + rh) * w + x + i] || !opaque(x + i, y + rh)) break grow;
        rh++;
      }
      for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) used[(y + j) * w + x + i] = 1;
      out.push([x, y, rw, rh]);
    }
  return out;
}

/**
 * Elements for one sprite layer: a 1px-thick slab per rectangle, the front
 * and back showing the rectangle of the texture, the edges its border pixels.
 * Layer `n` sits a hair in front of the one below, and has tint index `n`
 * (as `item/generated` gives it).
 */
export function spriteLayerElements(img: PixelImage, slot: string, layer: number, frameHeight = img.h): Element[] {
  const sx = 16 / img.w;
  const sy = 16 / Math.min(frameHeight, img.h);
  const r = (n: number) => Math.round(n * 1000) / 1000;
  const grow = layer * 0.01;
  const tex = `#${slot}`;
  return opaqueRects(img, frameHeight).map(([x, y, w, h], i) => {
    const u0 = r(x * sx);
    const u1 = r((x + w) * sx);
    const v0 = r(y * sy);
    const v1 = r((y + h) * sy);
    const face = (uv: Uv) => ({ texture: tex, uv, tint: layer });
    return {
      name: `${slot}_${i + 1}`,
      from: [u0, r(16 - v1), r(7.5 - grow)],
      to: [u1, r(16 - v0), r(8.5 + grow)],
      faces: {
        south: face([u0, v0, u1, v1]),
        north: face([u1, v0, u0, v1]),
        up: face([u0, v0, u1, r(v0 + sy)]),
        down: face([u0, r(v1 - sy), u1, v1]),
        west: face([u0, v0, r(u0 + sx), v1]),
        east: face([r(u1 - sx), v0, u1, v1]),
      },
    };
  });
}
