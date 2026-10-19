// What's painted: the slot and texture (and its animation frame), and the textures shown with the painting over them.

import { useEffect, useMemo } from "react";
import type { EditorProps } from "substrate-platform-ui";
import type { LoadedTexture } from "../contentModel";
import type { ContentModel } from "../useContentModel";
import type { ContentTextures } from "../useContentTextures";

/** What's painted: the slot and texture (and its animation frame), and the textures shown with the painting over them. */
export function usePaintTarget(props: EditorProps, m: ContentModel, tx: ContentTextures) {
  const { readOnly } = props;
  const { face, images, paintMode, paintSlot, setPaintSlot, edited, animEdits, paintEntry, playing, resolved, selEl } = m;
  const { animOf } = tx;
  // ── Painting ──────────────────────────────────────────────────────────────

  const paintOn = !readOnly && (paintMode || !!resolved.sprite);
  const faceSlot = selEl && face ? selEl.faces[face]?.texture.replace(/^#/, "") : undefined;
  const paintSlots = resolved.slots.filter((s) => resolved.textures[s] && s !== "particle");
  const activeSlot = paintSlot && paintSlots.includes(paintSlot) ? paintSlot : faceSlot && paintSlots.includes(faceSlot) ? faceSlot : (paintSlots[0] ?? null);
  const activeKey = activeSlot ? resolved.textures[activeSlot] : undefined;
  const activeAnim = animOf(activeKey);
  const activeEntry = activeKey && activeAnim ? Math.max(0, Math.min(paintEntry[activeKey] ?? 0, activeAnim.frames.length - 1)) : 0;
  /** The image frame painted: the picked step's (frame 0 — the whole image — when it isn't animated). */
  const activeFrame = activeAnim?.frames[activeEntry]?.index ?? 0;

  /** What the view and the pickers show: painted textures over the loaded ones, the painted frame held while painting. */
  const shownImages = useMemo(() => {
    const out: Record<string, LoadedTexture | undefined> = {};
    for (const k of new Set([...Object.keys(images), ...Object.keys(edited)])) {
      const loaded = images[k];
      const e = edited[k];
      if (!loaded && !e) {
        out[k] = undefined;
        continue;
      }
      const animation = animEdits[k] ? animEdits[k]!.animation : (loaded?.animation ?? null);
      const pinned = paintOn && !playing && k === activeKey && animation ? activeFrame : undefined;
      out[k] = { url: e?.url ?? loaded!.url, animation, writable: e ? true : loaded!.writable, pinned };
    }
    return out;
  }, [images, edited, animEdits, paintOn, playing, activeKey, activeFrame]);
  // The 2D view follows the face picked in the outliner or the view.
  useEffect(() => {
    if (faceSlot) setPaintSlot(faceSlot);
  }, [faceSlot]);

  /** A new texture of the mod for `slot` — `@texture:<mod>:item/<file>`, `…:block/<file>_<slot>` and the like, not yet taken. */

  return { paintOn, faceSlot, paintSlots, activeSlot, activeKey, activeAnim, activeEntry, activeFrame, shownImages };
}

/** What `usePaintTarget` gives. */
export type PaintTarget = ReturnType<typeof usePaintTarget>;
