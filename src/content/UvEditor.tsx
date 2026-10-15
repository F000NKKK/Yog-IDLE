import { frameRect } from "./animation";
import { useEffect, useRef, useState } from "react";
import type { TextureSource } from "./Viewport";
import type { Uv } from "./model";

// The 2D UV editor: the face's texture (one frame of an animated one) on a
// 16×16 pixel grid, the selected face's rectangle on it — drag inside to move
// it, drag a corner or edge to resize it; snapping to whole pixels (Shift:
// quarter pixels). Other faces using the same texture are outlined faintly.
// A flipped face (u2 < u1 or v2 < v1) is allowed, as in Minecraft.

export interface UvEditorProps {
  image?: TextureSource;
  uv: Uv;
  /** Other faces' rects on the same texture. */
  others?: Uv[];
  onCommit: (uv: Uv) => void;
  readOnly?: boolean;
}

type Grab = "move" | "n" | "s" | "w" | "e" | "nw" | "ne" | "sw" | "se";

const SIZE = 256;
const PAD = 8;

export function UvEditor({ image, uv, others = [], onCommit, readOnly }: UvEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [live, setLive] = useState<Uv | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const shown = live ?? uv;

  useEffect(() => {
    if (!image) {
      setImg(null);
      return;
    }
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = image.url;
  }, [image]);

  useEffect(() => {
    const c = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = (SIZE + PAD * 2) * dpr;
    c.height = (SIZE + PAD * 2) * dpr;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, SIZE + PAD * 2, SIZE + PAD * 2);
    // Checkerboard under transparent pixels.
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        g.fillStyle = (x + y) % 2 ? "#3a3a3a" : "#444";
        g.fillRect(PAD + x * 16, PAD + y * 16, 16, 16);
      }
    if (img) {
      // An animated texture: the frame shown (held while painting), else its first.
      const anim = image?.animation;
      const [fx, fy, fw, fh] = anim ? frameRect(anim, img.width, image.pinned ?? anim.frames[0]?.index ?? 0) : [0, 0, img.width, img.height];
      g.drawImage(img, fx, fy, fw, fh, PAD, PAD, SIZE, SIZE);
    }
    g.strokeStyle = "rgba(255,255,255,0.08)";
    g.lineWidth = 1;
    for (let i = 0; i <= 16; i++) {
      g.beginPath();
      g.moveTo(PAD + i * 16 + 0.5, PAD);
      g.lineTo(PAD + i * 16 + 0.5, PAD + SIZE);
      g.moveTo(PAD, PAD + i * 16 + 0.5);
      g.lineTo(PAD + SIZE, PAD + i * 16 + 0.5);
      g.stroke();
    }
    const rect = (r: Uv) => {
      const x1 = Math.min(r[0], r[2]);
      const y1 = Math.min(r[1], r[3]);
      return [PAD + x1 * 16, PAD + y1 * 16, Math.abs(r[2] - r[0]) * 16, Math.abs(r[3] - r[1]) * 16] as const;
    };
    g.setLineDash([3, 3]);
    g.strokeStyle = "rgba(255,255,255,0.45)";
    for (const o of others) g.strokeRect(...rect(o));
    g.setLineDash([]);
    g.strokeStyle = "#3b8eea";
    g.lineWidth = 2;
    const [x, y, w, h] = rect(shown);
    g.fillStyle = "rgba(59,142,234,0.15)";
    g.fillRect(x, y, w, h);
    g.strokeRect(x, y, w, h);
    g.fillStyle = "#3b8eea";
    for (const [hx, hy] of [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h],
    ])
      g.fillRect(hx - 3, hy - 3, 6, 6);
  }, [img, image, shown, others]);

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (readOnly || e.button !== 0) return;
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    const scale = (SIZE + PAD * 2) / r.width;
    const toUv = (cx: number, cy: number) => [((cx - r.left) * scale - PAD) / 16, ((cy - r.top) * scale - PAD) / 16] as const;
    const [u, v] = toUv(e.clientX, e.clientY);
    const start = [...uv] as Uv;
    // Which part of the (normalized) rect was grabbed.
    const lo = [Math.min(start[0], start[2]), Math.min(start[1], start[3])];
    const hi = [Math.max(start[0], start[2]), Math.max(start[1], start[3])];
    const tol = 0.5;
    const nearW = Math.abs(u - lo[0]) < tol;
    const nearE = Math.abs(u - hi[0]) < tol;
    const nearN = Math.abs(v - lo[1]) < tol;
    const nearS = Math.abs(v - hi[1]) < tol;
    const inside = u > lo[0] - tol && u < hi[0] + tol && v > lo[1] - tol && v < hi[1] + tol;
    if (!inside) return;
    const grab: Grab = (`${nearN ? "n" : nearS ? "s" : ""}${nearW ? "w" : nearE ? "e" : ""}` || "move") as Grab;
    // Edges in terms of the uv's own indices (it may be flipped).
    const uLo = start[0] <= start[2] ? 0 : 2;
    const uHi = 2 - uLo;
    const vLo = start[1] <= start[3] ? 1 : 3;
    const vHi = 4 - vLo;
    c.setPointerCapture(e.pointerId);
    let result: Uv = start;
    const move = (ev: PointerEvent) => {
      const [u2, v2] = toUv(ev.clientX, ev.clientY);
      const step = ev.shiftKey ? 0.25 : 1;
      const snap = (n: number) => Math.min(16, Math.max(0, Math.round(n / step) * step));
      const du = Math.round((u2 - u) / step) * step;
      const dv = Math.round((v2 - v) / step) * step;
      const next = [...start] as Uv;
      if (grab === "move") {
        const w = hi[0] - lo[0];
        const h = hi[1] - lo[1];
        const nu = Math.min(16 - w, Math.max(0, lo[0] + du));
        const nv = Math.min(16 - h, Math.max(0, lo[1] + dv));
        next[uLo] = nu;
        next[uHi] = nu + w;
        next[vLo] = nv;
        next[vHi] = nv + h;
      } else {
        if (grab.includes("w")) next[uLo] = snap(start[uLo] + du);
        if (grab.includes("e")) next[uHi] = snap(start[uHi] + du);
        if (grab.includes("n")) next[vLo] = snap(start[vLo] + dv);
        if (grab.includes("s")) next[vHi] = snap(start[vHi] + dv);
      }
      result = next;
      setLive(next);
    };
    const up = () => {
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerup", up);
      setLive(null);
      if (result.some((n, i) => n !== start[i])) onCommit(result);
    };
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
  };

  return (
    <div className="content-uv">
      <canvas ref={canvasRef} onPointerDown={onDown} style={{ width: SIZE + PAD * 2, height: SIZE + PAD * 2 }} />
      <div className="content-uv-readout">{shown.map((n) => Math.round(n * 1000) / 1000).join(", ")}</div>
    </div>
  );
}
