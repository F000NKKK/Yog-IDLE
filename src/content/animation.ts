import { blankImage, type PixelImage } from "./paint/pixels";

// A texture's animation (its `.png.mcmeta`, read by the backend's
// `content::Animation`): frames laid row by row over the image, played in
// `frames` order, each for `time` ticks — 20 a second, as the game plays it.

export interface AnimationFrame {
  /** Which frame of the image (row by row). */
  index: number;
  /** Ticks. */
  time: number;
}

export interface TextureAnimation {
  frameWidth: number;
  frameHeight: number;
  frames: AnimationFrame[];
  interpolate: boolean;
}

export const TICKS_PER_SECOND = 20;

/** How many frames the image holds. */
export function frameCount(a: TextureAnimation, w: number, h: number): number {
  return Math.floor(w / a.frameWidth) * Math.floor(h / a.frameHeight);
}

/** Image frame `index`'s rectangle, pixels: `[x, y, w, h]`. */
export function frameRect(a: TextureAnimation, w: number, index: number): [number, number, number, number] {
  const cols = Math.max(1, Math.floor(w / a.frameWidth));
  return [(index % cols) * a.frameWidth, Math.floor(index / cols) * a.frameHeight, a.frameWidth, a.frameHeight];
}

/** The whole loop's length, ticks. */
export function loopTicks(a: TextureAnimation): number {
  return a.frames.reduce((n, f) => n + Math.max(1, f.time), 0);
}

/** Which entry of `frames` shows at `tick` (the loop repeating). */
export function entryAt(a: TextureAnimation, tick: number): number {
  const total = loopTicks(a);
  if (!total) return 0;
  let t = ((Math.floor(tick) % total) + total) % total;
  for (let i = 0; i < a.frames.length; i++) {
    t -= Math.max(1, a.frames[i].time);
    if (t < 0) return i;
  }
  return 0;
}

/** The image frame showing now (`performance.now()` ms). */
export function frameNow(a: TextureAnimation, ms: number): number {
  return a.frames[entryAt(a, (ms / 1000) * TICKS_PER_SECOND)]?.index ?? 0;
}

/** Milliseconds until the shown frame next changes. */
export function msToNextFrame(a: TextureAnimation, ms: number): number {
  const total = loopTicks(a);
  if (!total) return Infinity;
  const tick = (ms / 1000) * TICKS_PER_SECOND;
  let t = ((tick % total) + total) % total;
  for (const f of a.frames) {
    const len = Math.max(1, f.time);
    if (t < len) return ((len - t) / TICKS_PER_SECOND) * 1000;
    t -= len;
  }
  return 1000 / TICKS_PER_SECOND;
}

/** A copy of frame `index` of `img`. */
export function cropFrame(img: PixelImage, a: TextureAnimation, index: number): PixelImage {
  const [x0, y0, w, h] = frameRect(a, img.w, index);
  const out = blankImage(w, h);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * img.w + x0) * 4;
    out.data.set(img.data.subarray(from, from + w * 4), y * w * 4);
  }
  return out;
}

/** `img` with frame `index` replaced by `frame`. */
export function pasteFrame(img: PixelImage, a: TextureAnimation, index: number, frame: PixelImage): PixelImage {
  const [x0, y0, w, h] = frameRect(a, img.w, index);
  const out: PixelImage = { w: img.w, h: img.h, data: new Uint8ClampedArray(img.data) };
  for (let y = 0; y < Math.min(h, frame.h); y++) {
    const to = ((y0 + y) * img.w + x0) * 4;
    out.data.set(frame.data.subarray(y * frame.w * 4, y * frame.w * 4 + Math.min(w, frame.w) * 4), to);
  }
  return out;
}

/**
 * A new image frame, a copy of frame `copyOf`, added under the last row
 * (the image grows a frame taller) — returns the image and its index.
 */
export function addImageFrame(img: PixelImage, a: TextureAnimation, copyOf: number): { img: PixelImage; index: number } {
  const count = frameCount(a, img.w, img.h);
  const cols = Math.max(1, Math.floor(img.w / a.frameWidth));
  const rows = Math.ceil((count + 1) / cols);
  const h = Math.max(img.h, rows * a.frameHeight);
  const grown = blankImage(img.w, h);
  grown.data.set(img.data);
  return { img: pasteFrame(grown, a, count, cropFrame(img, a, copyOf)), index: count };
}

/** An animation for a still image: one frame, the whole image. */
export function stillAnimation(img: PixelImage): TextureAnimation {
  return { frameWidth: img.w, frameHeight: img.h, frames: [{ index: 0, time: 1 }], interpolate: false };
}

export function sameAnimation(a: TextureAnimation | null | undefined, b: TextureAnimation | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
