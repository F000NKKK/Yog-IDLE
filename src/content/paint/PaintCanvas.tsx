import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PixelImage } from "./pixels";

// A 2D pixel-art canvas: the image magnified over a checkerboard, a pixel
// grid, outlined rectangles on top (UV regions, say), and the brush under
// the pointer. Wheel zooms around the pointer, middle/right drag (or
// Space + drag) pans, Home or 0 fits the image. Left press/drag/release is
// reported as pixel coordinates — the host runs the tools. Product-agnostic.

export type PaintPhase = "down" | "move" | "up";

export interface PaintModifiers {
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
}

export interface PaintCanvasProps {
  image: PixelImage | null;
  /** Rectangles outlined on the image, in pixels `[x0, y0, x1, y1]`; `primary` = highlighted. */
  overlays?: { rect: [number, number, number, number]; primary?: boolean }[];
  grid: boolean;
  brushSize: number;
  mirrorX: boolean;
  onPaint?: (x: number, y: number, phase: PaintPhase, mods: PaintModifiers) => void;
  /** Shown when there's no image. */
  emptyText?: string;
  className?: string;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 128;

export function PaintCanvas({ image, overlays = [], grid, brushSize, mirrorX, onPaint, emptyText, className }: PaintCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ zoom: 8, x: 0, y: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<[number, number] | null>(null);

  const bitmap = useMemo(() => {
    if (!image) return null;
    const c = document.createElement("canvas");
    c.width = image.w;
    c.height = image.h;
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.w, image.h), 0, 0);
    return c;
  }, [image]);

  const fit = useCallback(() => {
    if (!image || !size.w || !size.h) return;
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor((Math.min(size.w, size.h) * 0.88) / Math.max(image.w, image.h))));
    setView({ zoom, x: Math.round((size.w - image.w * zoom) / 2), y: Math.round((size.h - image.h * zoom) / 2) });
  }, [image, size]);

  // Fit when the image's dimensions or the view's size change.
  const dims = image ? `${image.w}x${image.h}` : "";
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => fitRef.current(), [dims, size.w, size.h]);

  useEffect(() => {
    const host = hostRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: host.clientWidth, h: host.clientHeight }));
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // ── Drawing ───────────────────────────────────────────────────────────────

  useEffect(() => {
    const c = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(size.w * dpr));
    c.height = Math.max(1, Math.round(size.h * dpr));
    c.style.width = `${size.w}px`;
    c.style.height = `${size.h}px`;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, size.w, size.h);
    if (!image || !bitmap) return;
    const { zoom, x: ox, y: oy } = view;
    const W = image.w * zoom;
    const H = image.h * zoom;
    // Checkerboard: two cells per pixel at large zooms, one per few pixels when small.
    const cell = Math.max(4, zoom / 2);
    g.save();
    g.beginPath();
    g.rect(ox, oy, W, H);
    g.clip();
    for (let y = 0; y * cell < H; y++)
      for (let x = 0; x * cell < W; x++) {
        g.fillStyle = (x + y) % 2 ? "#3a3a3a" : "#4a4a4a";
        g.fillRect(ox + x * cell, oy + y * cell, cell, cell);
      }
    g.restore();
    g.drawImage(bitmap, ox, oy, W, H);
    if (grid && zoom >= 6) {
      g.strokeStyle = "rgba(255,255,255,0.1)";
      g.lineWidth = 1;
      g.beginPath();
      for (let i = 0; i <= image.w; i++) {
        g.moveTo(Math.round(ox + i * zoom) + 0.5, oy);
        g.lineTo(Math.round(ox + i * zoom) + 0.5, oy + H);
      }
      for (let i = 0; i <= image.h; i++) {
        g.moveTo(ox, Math.round(oy + i * zoom) + 0.5);
        g.lineTo(ox + W, Math.round(oy + i * zoom) + 0.5);
      }
      g.stroke();
    }
    g.strokeStyle = "rgba(255,255,255,0.35)";
    g.strokeRect(ox - 0.5, oy - 0.5, W + 1, H + 1);
    for (const o of [...overlays].sort((a, b) => Number(!!a.primary) - Number(!!b.primary))) {
      const [x0, y0, x1, y1] = o.rect;
      const rx = ox + Math.min(x0, x1) * zoom;
      const ry = oy + Math.min(y0, y1) * zoom;
      const rw = Math.abs(x1 - x0) * zoom;
      const rh = Math.abs(y1 - y0) * zoom;
      g.setLineDash(o.primary ? [] : [3, 3]);
      g.lineWidth = o.primary ? 2 : 1;
      g.strokeStyle = o.primary ? "#3b8eea" : "rgba(255,255,255,0.5)";
      g.strokeRect(rx, ry, rw, rh);
    }
    g.setLineDash([]);
    if (hover) {
      const off = Math.floor((brushSize - 1) / 2);
      const box = (px: number) => {
        g.lineWidth = 1;
        g.strokeStyle = "rgba(0,0,0,0.7)";
        g.strokeRect(ox + px * zoom - 0.5, oy + (hover[1] - off) * zoom - 0.5, brushSize * zoom + 1, brushSize * zoom + 1);
        g.strokeStyle = "rgba(255,255,255,0.9)";
        g.strokeRect(ox + px * zoom + 0.5, oy + (hover[1] - off) * zoom + 0.5, brushSize * zoom - 1, brushSize * zoom - 1);
      };
      box(hover[0] - off);
      if (mirrorX) box(image.w - 1 - (hover[0] - off) - (brushSize - 1));
    }
    if (mirrorX) {
      g.strokeStyle = "rgba(59,142,234,0.6)";
      g.setLineDash([4, 4]);
      g.beginPath();
      g.moveTo(ox + W / 2, oy - 6);
      g.lineTo(ox + W / 2, oy + H + 6);
      g.stroke();
      g.setLineDash([]);
    }
  }, [image, bitmap, view, size, grid, overlays, hover, brushSize, mirrorX]);

  // ── Input ─────────────────────────────────────────────────────────────────

  const viewRef = useRef(view);
  viewRef.current = view;
  const onPaintRef = useRef(onPaint);
  onPaintRef.current = onPaint;
  const space = useRef(false);

  const pixelAt = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = hostRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return [Math.floor((e.clientX - r.left - v.x) / v.zoom), Math.floor((e.clientY - r.top - v.y) / v.zoom)];
  };
  const mods = (e: React.PointerEvent | PointerEvent): PaintModifiers => ({ alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    hostRef.current!.focus();
    const host = e.currentTarget;
    host.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2 || (e.button === 0 && space.current)) {
      e.preventDefault();
      let last = { x: e.clientX, y: e.clientY };
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - last.x;
        const dy = ev.clientY - last.y;
        last = { x: ev.clientX, y: ev.clientY };
        setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      };
      const up = () => {
        host.removeEventListener("pointermove", move);
        host.removeEventListener("pointerup", up);
      };
      host.addEventListener("pointermove", move);
      host.addEventListener("pointerup", up);
      return;
    }
    if (e.button !== 0 || !image || !onPaintRef.current) return;
    const [x, y] = pixelAt(e);
    onPaintRef.current(x, y, "down", mods(e));
    let last = [x, y];
    const move = (ev: PointerEvent) => {
      const p = pixelAt(ev);
      if (p[0] === last[0] && p[1] === last[1]) return;
      last = p;
      onPaintRef.current?.(p[0], p[1], "move", mods(ev));
    };
    const up = (ev: PointerEvent) => {
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerup", up);
      const p = pixelAt(ev);
      onPaintRef.current?.(p[0], p[1], "up", mods(ev));
    };
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerup", up);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!image) return;
    const [x, y] = pixelAt(e);
    const inside = x >= 0 && y >= 0 && x < image.w && y < image.h;
    setHover((h) => (inside ? (h && h[0] === x && h[1] === y ? h : [x, y]) : null));
  };

  useEffect(() => {
    const host = hostRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = host.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setView((v) => {
        const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(v.zoom * (e.deltaY < 0 ? 1.25 : 0.8)) || 1));
        if (zoom === v.zoom) return v;
        // Keep the pixel under the pointer where it is.
        return { zoom, x: mx - ((mx - v.x) * zoom) / v.zoom, y: my - ((my - v.y) * zoom) / v.zoom };
      });
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.code === "Space") {
      space.current = true;
      e.preventDefault();
    } else if (e.code === "Home" || e.code === "Digit0" || e.code === "Numpad0") {
      fit();
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    <div
      ref={hostRef}
      className={className}
      tabIndex={0}
      style={{ position: "relative", overflow: "hidden", outline: "none", cursor: image ? "crosshair" : "default" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => e.code === "Space" && (space.current = false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={canvasRef} style={{ display: "block" }} />
      <div className="paint-canvas-hud">
        {image
          ? `${image.w}×${image.h} · ${Math.round(view.zoom * 100)}%${hover ? ` · ${hover[0]}, ${hover[1]}` : ""}`
          : (emptyText ?? "")}
      </div>
    </div>
  );
}
