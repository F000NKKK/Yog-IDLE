// Pixel images and the paint tools that edit them — plain RGBA arrays, no
// DOM except for converting to/from PNG. Product-agnostic: nothing here
// knows about Minecraft or models.

export interface PixelImage {
  w: number;
  h: number;
  /** RGBA, row-major, `w * h * 4` bytes. */
  data: Uint8ClampedArray;
}

/** `[r, g, b, a]`, 0–255. */
export type Rgba = [number, number, number, number];

export type PaintTool = "pencil" | "eraser" | "fill" | "picker" | "line" | "rect";

export interface PaintSettings {
  tool: PaintTool;
  color: Rgba;
  /** Brush size in pixels, 1–4. */
  size: number;
  /** Also paint mirrored across the vertical center line. */
  mirrorX: boolean;
  /** Fill: every pixel of the clicked color, not just the connected area. */
  fillGlobal: boolean;
  /** Rectangle: filled rather than an outline. */
  rectFilled: boolean;
}

export const blankImage = (w: number, h: number): PixelImage => ({ w, h, data: new Uint8ClampedArray(w * h * 4) });

export const cloneImage = (img: PixelImage): PixelImage => ({ w: img.w, h: img.h, data: new Uint8ClampedArray(img.data) });

export function sameImage(a: PixelImage | null | undefined, b: PixelImage | null | undefined): boolean {
  if (!a || !b) return a === b;
  if (a === b) return true;
  if (a.w !== b.w || a.h !== b.h) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

export function getPixel(img: PixelImage, x: number, y: number): Rgba | null {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return null;
  const i = (y * img.w + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

function setPixel(img: PixelImage, x: number, y: number, c: Rgba) {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
  const i = (y * img.w + x) * 4;
  img.data[i] = c[0];
  img.data[i + 1] = c[1];
  img.data[i + 2] = c[2];
  img.data[i + 3] = c[3];
}

const sameColor = (a: Rgba, b: Rgba) => (a[3] === 0 && b[3] === 0) || (a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]);

/** A square brush of `size` with its top-left at `x - (size-1)/2` (and its mirror). */
function stamp(img: PixelImage, x: number, y: number, c: Rgba, s: PaintSettings) {
  const o = Math.floor((s.size - 1) / 2);
  for (let dy = 0; dy < s.size; dy++)
    for (let dx = 0; dx < s.size; dx++) {
      setPixel(img, x - o + dx, y - o + dy, c);
      if (s.mirrorX) setPixel(img, img.w - 1 - (x - o + dx), y - o + dy, c);
    }
}

/** The pixels of a line (Bresenham). */
function linePoints(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let i = 0; i < 10000; i++) {
    out.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
  return out;
}

/** Fills the area of `(x, y)`'s color — connected (4-way) or everywhere. */
export function fill(img: PixelImage, x: number, y: number, c: Rgba, global: boolean, mirrorX = false) {
  const target = getPixel(img, x, y);
  if (!target || sameColor(target, c)) return;
  const { w, h, data } = img;
  const [r, g, b, a] = target;
  // `sameColor(pixel at i, target)` without allocating the pixel.
  const matches = (i: number) => (a === 0 ? data[i + 3] === 0 : data[i] === r && data[i + 1] === g && data[i + 2] === b && data[i + 3] === a);
  const paint = (i: number) => {
    data[i] = c[0];
    data[i + 1] = c[1];
    data[i + 2] = c[2];
    data[i + 3] = c[3];
  };
  if (global) {
    for (let i = 0; i < data.length; i += 4) if (matches(i)) paint(i);
    return;
  }
  // Pixel indices; each is pushed at most once, so `w * h` slots suffice.
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  const push = (p: number) => {
    if (seen[p]) return;
    seen[p] = 1;
    stack[top++] = p;
  };
  push(y * w + x);
  while (top) {
    const p = stack[--top];
    if (!matches(p * 4)) continue;
    paint(p * 4);
    const px = p % w;
    if (px + 1 < w) push(p + 1);
    if (px > 0) push(p - 1);
    if (p + w < w * h) push(p + w);
    if (p >= w) push(p - w);
  }
  if (mirrorX) fill(img, w - 1 - x, y, c, false);
}

/**
 * One press-drag-release of a tool on an image: `move` returns the image as
 * it would be if released there (a line or rectangle is redrawn from the
 * start each time). `picker` doesn't paint — the host reads the color.
 */
export class Stroke {
  readonly base: PixelImage;
  readonly settings: PaintSettings;
  image: PixelImage;
  private last: [number, number];
  private readonly start: [number, number];

  constructor(base: PixelImage, settings: PaintSettings, x: number, y: number) {
    this.base = base;
    this.settings = settings;
    this.image = cloneImage(base);
    this.start = [x, y];
    this.last = [x, y];
    const s = settings;
    if (s.tool === "pencil" || s.tool === "eraser") stamp(this.image, x, y, this.color, s);
    else if (s.tool === "fill") fill(this.image, x, y, s.color, s.fillGlobal, s.mirrorX);
    else if (s.tool === "line" || s.tool === "rect") this.shape(x, y);
  }

  private get color(): Rgba {
    return this.settings.tool === "eraser" ? [0, 0, 0, 0] : this.settings.color;
  }

  move(x: number, y: number): PixelImage {
    const s = this.settings;
    if (s.tool === "pencil" || s.tool === "eraser") {
      if (x === this.last[0] && y === this.last[1]) return this.image;
      for (const [px, py] of linePoints(this.last[0], this.last[1], x, y).slice(1)) stamp(this.image, px, py, this.color, s);
      this.image = { ...this.image };
    } else if (s.tool === "line" || s.tool === "rect") {
      if (x === this.last[0] && y === this.last[1]) return this.image;
      this.image = cloneImage(this.base);
      this.shape(x, y);
    }
    this.last = [x, y];
    return this.image;
  }

  private shape(x: number, y: number) {
    const [x0, y0] = this.start;
    const s = this.settings;
    if (s.tool === "line") {
      for (const [px, py] of linePoints(x0, y0, x, y)) stamp(this.image, px, py, s.color, s);
      return;
    }
    const [l, r] = [Math.min(x0, x), Math.max(x0, x)];
    const [t, b] = [Math.min(y0, y), Math.max(y0, y)];
    for (let py = t; py <= b; py++)
      for (let px = l; px <= r; px++) {
        if (!s.rectFilled && px !== l && px !== r && py !== t && py !== b) continue;
        setPixel(this.image, px, py, s.color);
        if (s.mirrorX) setPixel(this.image, this.image.w - 1 - px, py, s.color);
      }
  }
}

// ── Colors ───────────────────────────────────────────────────────────────────

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

/** `#rrggbb`, or `#rrggbbaa` when not opaque. */
export const rgbaToHex = (c: Rgba) => `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}${c[3] === 255 ? "" : hex2(c[3])}`;

export function hexToRgba(text: string): Rgba | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  if (h.length === 6) h += "ff";
  return [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgba;
}

export const rgbaToCss = (c: Rgba) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.round((c[3] / 255) * 1000) / 1000})`;

// ── PNG ──────────────────────────────────────────────────────────────────────

function toCanvas(img: PixelImage): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = img.w;
  c.height = img.h;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.w, img.h), 0, 0);
  return c;
}

/** `data:image/png;base64,...` */
export const toPngDataUrl = (img: PixelImage) => toCanvas(img).toDataURL("image/png");

/** Decodes an image URL (a data URL, say) to pixels. */
export function decodeImage(url: string): Promise<PixelImage> {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => {
      const c = document.createElement("canvas");
      c.width = i.width;
      c.height = i.height;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(i, 0, 0);
      resolve({ w: i.width, h: i.height, data: g.getImageData(0, 0, i.width, i.height).data });
    };
    i.onerror = () => reject(new Error("can't decode the image"));
    i.src = url;
  });
}
