// New textures: where one goes, and assigning one to a slot.

import { documentAction, type EditorProps, stemOf } from "substrate-platform-ui";
import type { PixelImage } from "../../../content/paint/pixels";
import { TYPED } from "../../../data/yogFormat";
import { kind as KIND, sep } from "../../../data/yogIds.generated";
import { ensureModel, MODEL, stateModelOf } from "../contentModel";
import type { ContentModel } from "../useContentModel";
import type { ContentTextures } from "../useContentTextures";
import type { PaintTarget } from "./usePaintTarget";

/** New textures: where one goes, and assigning one to a slot. */
export function usePaintTextures(props: EditorProps, m: ContentModel, tx: ContentTextures, paintTarget: PaintTarget) {
  const { path } = props;
  const { choices, editedRef, effectiveKey, modelKind, resolved, setEditedImages, update, pixelStep } = m;
  const { named } = tx;
  const { paintSlots } = paintTarget;
  const newTexturePath = (slot: string): string => {
    const stem = (stemOf(path) || "texture").toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
    const folder = modelKind === KIND.ITEM || resolved.sprite ? "item" : "block";
    const state = stateModelOf(effectiveKey);
    const several = paintSlots.length > 1 || effectiveKey === MODEL.arm || state !== null;
    const base = `${folder}/${stem}${state !== null ? `_${state}` : ""}${several ? `_${slot}` : ""}`;
    const taken = new Set([...choices.textures, ...Object.keys(editedRef.current), ...named]);
    const ref = (p: string) => `${TYPED}${KIND.TEXTURE}${sep.NAMESPACE}${choices.modId}${sep.NAMESPACE}${p}`;
    let value = ref(base);
    for (let n = 2; taken.has(value); n++) value = ref(`${base}_${n}`);
    return value;
  };

  /** Points `slot` at a new texture `img` (a copy, or a blank one) — one undo step, the file and the texture. */
  const assignTexture = (slot: string, img: PixelImage): string => {
    const key = newTexturePath(slot);
    void documentAction(path, () => {
      const written = update((d) => {
        const m = ensureModel(d, effectiveKey);
        m.textures = { ...(m.textures ?? {}), [slot]: key };
      });
      setEditedImages({ [key]: img });
      pixelStep(key, null, img);
      return written;
    });
    return key;
  };

  /**
   * A stroke being painted: on one frame of an animated texture (`anim`,
   * image frame `frameIndex` of `strip`), else on the whole image.
   */

  return { newTexturePath, assignTexture };
}

/** What `usePaintTextures` gives. */
export type PaintTextures = ReturnType<typeof usePaintTextures>;
