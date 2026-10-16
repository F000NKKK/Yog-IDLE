import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** The game's spawn egg: its base, tinted by the first colour, and its spots, by the second (item layers 0 and 1). */
const LAYERS = ["minecraft:item/spawn_egg", "minecraft:item/spawn_egg_overlay"] as const;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * A spawn egg as the game draws it: each layer's pixels multiplied by its
 * colour (`0xRRGGBB`), pixelated at `size`. Nothing without a client jar
 * to take the textures from.
 */
export function SpawnEgg({ path, colors, size = 48 }: { path: string; colors: readonly [number, number]; size?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [layers, setLayers] = useState<HTMLImageElement[] | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all(LAYERS.map((id) => invoke<{ url: string }>("content_texture", { path, texture: id }).then((t) => loadImage(t.url))))
      .then((imgs) => live && setLayers(imgs))
      .catch(() => live && setLayers(null));
    return () => {
      live = false;
    };
  }, [path]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !layers) return;
    const [w, h] = [layers[0].naturalWidth, layers[0].naturalHeight];
    c.width = w;
    c.height = h;
    const g = c.getContext("2d")!;
    const out = g.createImageData(w, h);
    const scratch = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    scratch.canvas.width = w;
    scratch.canvas.height = h;
    layers.forEach((img, i) => {
      scratch.clearRect(0, 0, w, h);
      scratch.drawImage(img, 0, 0);
      const px = scratch.getImageData(0, 0, w, h).data;
      const tint = [(colors[i] >> 16) & 255, (colors[i] >> 8) & 255, colors[i] & 255];
      for (let p = 0; p < px.length; p += 4) {
        const a = px[p + 3] / 255;
        if (!a) continue;
        for (let k = 0; k < 3; k++) out.data[p + k] = out.data[p + k] * (1 - a) + ((px[p + k] * tint[k]) / 255) * a;
        out.data[p + 3] = Math.max(out.data[p + 3], px[p + 3]);
      }
    });
    g.putImageData(out, 0, 0);
  }, [layers, colors]);
  if (!layers) return null;
  return <canvas ref={canvas} className="spawn-egg" style={{ width: size, height: size, imageRendering: "pixelated" }} />;
}
