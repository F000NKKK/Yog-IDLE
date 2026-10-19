// Painting textures in the view or the 2D canvas, and an item sprite's layers.

import { type EditorProps } from "substrate-platform-ui";
import type { ContentModel } from "./useContentModel";
import type { ContentTextures } from "./useContentTextures";
import { usePaintTarget } from "./paint/usePaintTarget";
import { usePaintTextures } from "./paint/usePaintTextures";
import { usePaintStrokes } from "./paint/usePaintStrokes";
import { usePaintInput } from "./paint/usePaintInput";
import { useSpriteLayers } from "./paint/useSpriteLayers";
import { useSpriteConversion } from "./paint/useSpriteConversion";

/** Painting textures in the view or the 2D canvas, and an item sprite's layers. */
export function useContentPaint(props: EditorProps, m: ContentModel, tx: ContentTextures) {
  const paintTarget = usePaintTarget(props, m, tx);
  const paintTextures = usePaintTextures(props, m, tx, paintTarget);
  const paintStrokes = usePaintStrokes(m, tx, paintTarget, paintTextures);
  const paintInput = usePaintInput(props, m, paintTarget, paintTextures, paintStrokes);
  const spriteLayers = useSpriteLayers(m, tx, paintTextures);
  const spriteConversion = useSpriteConversion(m, tx);
  const { paintOn, faceSlot, paintSlots, activeSlot, activeKey, activeAnim, activeEntry, activeFrame, shownImages } = paintTarget;
  const { newTexturePath, assignTexture } = paintTextures;
  const { stroke, strokeImage, beginPaint, movePaint, endPaint } = paintStrokes;
  const { editAnimation, onCanvasPaint, onViewportPaint, newTexture } = paintInput;
  const { layers, setLayers, layerValues, addLayer, removeLayer, moveLayer } = spriteLayers;
  const { convertToElements } = spriteConversion;
  return { paintOn, faceSlot, paintSlots, activeSlot, activeKey, activeAnim, activeEntry, activeFrame, shownImages, newTexturePath, assignTexture, stroke, strokeImage, beginPaint, movePaint, endPaint, editAnimation, onCanvasPaint, onViewportPaint, newTexture, layers, setLayers, layerValues, addLayer, removeLayer, moveLayer, convertToElements };
}

/** What `useContentPaint` gives the editor. */
export type ContentPaint = ReturnType<typeof useContentPaint>;
