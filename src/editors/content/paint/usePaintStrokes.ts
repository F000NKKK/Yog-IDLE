// A stroke: begun, moved and ended on a texture's pixels, one undo step each.

import { useRef } from "react";
import { notify } from "substrate-platform-ui";
import { cropFrame, pasteFrame, type TextureAnimation } from "../../../content/animation";
import { cloneImage, getPixel, type PixelImage, sameImage, Stroke } from "../../../content/paint/pixels";
import type { ContentModel } from "../useContentModel";
import type { ContentTextures } from "../useContentTextures";
import type { PaintTarget } from "./usePaintTarget";
import type { PaintTextures } from "./usePaintTextures";

/** A stroke: begun, moved and ended on a texture's pixels, one undo step each. */
export function usePaintStrokes(m: ContentModel, tx: ContentTextures, paintTarget: PaintTarget, paintTextures: PaintTextures) {
  const { t, images, paint, setPaint, usedColor, editedRef, resolved, setEditedImages, setAnimations, pixelStep } = m;
  const { pixelsOf, animOf } = tx;
  const { paintOn, activeKey, activeFrame } = paintTarget;
  const { assignTexture } = paintTextures;
  const stroke = useRef<{ stroke: Stroke; slot: string; key: string; frame: number; anim: TextureAnimation | null; frameIndex: number; strip: PixelImage } | null>(null);
  /** The texture image with the stroke's pixels in it. */
  const strokeImage = (cur: NonNullable<typeof stroke.current>): PixelImage =>
    cur.anim ? pasteFrame(cur.strip, cur.anim, cur.frameIndex, cur.stroke.image) : cur.stroke.image;

  const beginPaint = (slot: string, x: number, y: number, pick: boolean) => {
    if (!paintOn || stroke.current) return;
    let key = resolved.textures[slot];
    let base = pixelsOf(key);
    if (!key || !base) return;
    // An animated texture is painted a frame at a time: the one picked in
    // the frame strip (for the texture in the 2D view), else the first.
    const anim = animOf(key);
    const frameIndex = anim ? (key === activeKey ? activeFrame : (anim.frames[0]?.index ?? 0)) : 0;
    const frameOf = (img: PixelImage) => (anim ? cropFrame(img, anim, frameIndex) : img);
    if (paint.tool === "picker" || pick) {
      const c = getPixel(frameOf(base), x, y);
      if (c) setPaint({ color: c, ...(paint.tool === "picker" ? { tool: "pencil" as const } : {}) });
      return;
    }
    if (paint.tool === "fill" && !getPixel(frameOf(base), x, y)) return;
    const writable = images[key]?.writable ?? key in editedRef.current;
    if (!writable) {
      // Not the mod's texture (Minecraft's, another mod's): paint a copy in the mod.
      base = cloneImage(base);
      key = assignTexture(slot, base);
      // The copy keeps the animation (written with it on Save).
      if (anim) setAnimations({ [key]: { animation: anim } });
      notify({ level: "info", message: t("Copied into the mod: {path}", { path: `resources/${key}` }) });
    }
    const s = new Stroke(frameOf(base), paint, x, y);
    stroke.current = { stroke: s, slot, key, frame: 0, anim, frameIndex, strip: base };
    setEditedImages({ [key]: strokeImage(stroke.current) });
  };

  const movePaint = (x: number, y: number) => {
    const cur = stroke.current;
    if (!cur) return;
    cur.stroke.move(x, y);
    // At most one redraw a frame.
    if (!cur.frame)
      cur.frame = requestAnimationFrame(() => {
        cur.frame = 0;
        if (stroke.current === cur) setEditedImages({ [cur.key]: strokeImage(cur) });
      });
  };

  const endPaint = () => {
    const cur = stroke.current;
    if (!cur) return;
    stroke.current = null;
    cancelAnimationFrame(cur.frame);
    const painted = strokeImage(cur);
    setEditedImages({ [cur.key]: painted });
    if (!sameImage(cur.stroke.image, cur.stroke.base)) {
      pixelStep(cur.key, cur.strip, painted);
      if (cur.stroke.settings.tool !== "eraser") usedColor(cur.stroke.settings.color);
    }
  };

  /** Changes texture `key`'s animation (and its image, when frames were added) — one undo step. */

  return { stroke, strokeImage, beginPaint, movePaint, endPaint };
}

/** What `usePaintStrokes` gives. */
export type PaintStrokes = ReturnType<typeof usePaintStrokes>;
