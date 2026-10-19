// An item sprite's layers: listed, added, removed, reordered.

import { useMemo } from "react";
import { blankImage } from "../../../content/paint/pixels";
import { ensureModel, LAYER, layerIndex } from "../contentModel";
import type { ContentModel } from "../useContentModel";
import type { ContentTextures } from "../useContentTextures";
import type { PaintTextures } from "./usePaintTextures";

/** An item sprite's layers: listed, added, removed, reordered. */
export function useSpriteLayers(m: ContentModel, tx: ContentTextures, paintTextures: PaintTextures) {
  const { setPaintSlot, effectiveKey, model, resolved, update } = m;
  const { pixelsOf } = tx;
  const { assignTexture } = paintTextures;
  // ── Sprite layers ─────────────────────────────────────────────────────────

  const layers = useMemo(
    () => resolved.slots.filter((s) => LAYER.test(s)).sort((a, b) => layerIndex(a) - layerIndex(b)),
    [resolved.slots]
  );

  /** Rewrites the layers as `values` (`layer0`, `layer1`, … in order). */
  const setLayers = (values: string[]) =>
    update((d) => {
      const m = ensureModel(d, effectiveKey);
      const tex = Object.fromEntries(Object.entries(m.textures ?? {}).filter(([k]) => !LAYER.test(k)));
      values.forEach((v, i) => (tex[`layer${i}`] = v));
      m.textures = tex;
    });
  const layerValues = () => layers.map((s) => model?.textures?.[s] ?? resolved.textures[s] ?? "");

  const addLayer = () => {
    const first = pixelsOf(resolved.textures.layer0);
    const slot = `layer${layers.length}`;
    assignTexture(slot, blankImage(first?.w ?? 16, first?.h ?? 16));
    setPaintSlot(slot);
  };
  const removeLayer = (slot: string) => {
    setLayers(layerValues().filter((_, i) => layers[i] !== slot));
    setPaintSlot("layer0");
  };
  const moveLayer = (slot: string, by: -1 | 1) => {
    const i = layers.indexOf(slot);
    const values = layerValues();
    if (i + by < 0 || i + by >= values.length) return;
    [values[i], values[i + by]] = [values[i + by], values[i]];
    setLayers(values);
    setPaintSlot(`layer${i + by}`);
  };

  /** The sprite as elements of the model's own (one per rectangle of opaque pixels). */

  return { layers, setLayers, layerValues, addLayer, removeLayer, moveLayer };
}

/** What `useSpriteLayers` gives. */
export type SpriteLayers = ReturnType<typeof useSpriteLayers>;
