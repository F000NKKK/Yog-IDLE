import { useEffect, useRef, useState } from "react";
import { reference, serveMethod } from "../data/yogIds.generated";
import { cli } from "../cli";
import { gameId } from "../data/yogFormat";

/** The game's spawn egg: its base, tinted by the first color, and its spots, by the second (item layers 0 and 1). */
const SPAWN_EGG = [`${reference.TEXTURE}${gameId("item/spawn_egg")}`, `${reference.TEXTURE}${gameId("item/spawn_egg_overlay")}`] as const;

/** Its color that leaves a layer as it is. */
export const NO_TINT = 0xffffff;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/** A spawn egg as the game draws it, in its two colors. */
export function SpawnEgg({ path, colors, size = 48 }: { path: string; colors: readonly [number, number]; size?: number }) {
  return <TintedItem path={path} layers={SPAWN_EGG} colors={colors} size={size} />;
}

/**
 * An item drawn as the game draws a tinted one: its layers (texture ids)
 * one over another, each one's pixels multiplied by its color
 * (`0xRRGGBB`), pixelated at `size`. Nothing while the textures can't be
 * read (no client jar for the game's).
 */
export function TintedItem({ path, layers: ids, colors, size = 48, title }: { path: string; layers: readonly string[]; colors: readonly number[]; size?: number; title?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [layers, setLayers] = useState<HTMLImageElement[] | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all(ids.map((id) => cli<{ url: string }>(serveMethod.CONTENT_TEXTURE, { path, texture: id }).then((t) => loadImage(t.url))))
      .then((imgs) => live && setLayers(imgs))
      .catch(() => live && setLayers(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ids.join()]);
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
      const c = colors[i] ?? NO_TINT;
      const tint = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
      for (let p = 0; p < px.length; p += 4) {
        const a = px[p + 3] / 255;
        if (!a) continue;
        for (let k = 0; k < 3; k++) out.data[p + k] = out.data[p + k] * (1 - a) + ((px[p + k] * tint[k]) / 255) * a;
        out.data[p + 3] = Math.max(out.data[p + 3], px[p + 3]);
      }
    });
    g.putImageData(out, 0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, colors.join()]);
  if (!layers) return null;
  return <canvas ref={canvas} className="tinted-item" title={title} style={{ width: size, height: size, imageRendering: "pixelated" }} />;
}
