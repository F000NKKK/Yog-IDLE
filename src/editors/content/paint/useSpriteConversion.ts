// Converting an item sprite to 3D elements.

import { confirmDialog, reportError } from "substrate-platform-ui";
import { cropFrame } from "../../../content/animation";
import { clone, type Element } from "../../../content/model";
import { spriteLayerElements } from "../../../content/spriteElements";
import { ensureModel } from "../contentModel";
import type { ContentModel } from "../useContentModel";
import type { ContentTextures } from "../useContentTextures";

/** Converting an item sprite to 3D elements. */
export function useSpriteConversion(m: ContentModel, tx: ContentTextures) {
  const { t, setSelected, setFace, setPaintMode, effectiveKey, resolved, update } = m;
  const { pixelsOf, animOf } = tx;
  const convertToElements = async () => {
    const sprite = resolved.sprite;
    if (!sprite) return;
    const els: Element[] = [];
    for (const [i, { slot, texture }] of sprite.entries()) {
      const img = pixelsOf(texture);
      if (!img) {
        reportError(t("The texture {texture} isn't loaded.", { texture }));
        return;
      }
      // An animated sprite's shape is its first frame's.
      const anim = animOf(texture);
      els.push(...spriteLayerElements(anim ? cropFrame(img, anim, anim.frames[0]?.index ?? 0) : img, slot, i));
    }
    if (
      els.length > 256 &&
      !(await confirmDialog({
        title: t("Convert to 3D Elements"),
        message: t("This makes {n} elements — a lot for one model. Convert anyway?", { n: els.length }),
        confirmLabel: t("Convert"),
      }))
    )
      return;
    update((d) => {
      const m = ensureModel(d, effectiveKey);
      m.textures = { ...Object.fromEntries(sprite.map((l) => [l.slot, l.texture])), ...(m.textures ?? {}) };
      delete m.parent;
      m.elements = els;
      m.display = clone(resolved.display);
      m.gui_light = "front";
    });
    setPaintMode(true);
    setSelected(null);
    setFace(null);
  };

  return { convertToElements };
}

/** What `useSpriteConversion` gives. */
export type SpriteConversion = ReturnType<typeof useSpriteConversion>;
