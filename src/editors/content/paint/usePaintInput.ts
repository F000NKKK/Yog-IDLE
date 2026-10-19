// Painting from the 2D canvas or the 3D view, animations edited, New Texture.

import { documentAction, type EditorProps, showDialog } from "substrate-platform-ui";
import type { PaintHit } from "../../../content/Viewport";
import type { TextureAnimation } from "../../../content/animation";
import type { PaintModifiers, PaintPhase } from "../../../content/paint/PaintCanvas";
import { blankImage, type PixelImage } from "../../../content/paint/pixels";
import type { ContentModel } from "../useContentModel";
import type { PaintStrokes } from "./usePaintStrokes";
import type { PaintTarget } from "./usePaintTarget";
import type { PaintTextures } from "./usePaintTextures";

/** Painting from the 2D canvas or the 3D view, animations edited, New Texture. */
export function usePaintInput(props: EditorProps, m: ContentModel, paintTarget: PaintTarget, paintTextures: PaintTextures, paintStrokes: PaintStrokes) {
  const { path } = props;
  const { t, setSelected, setFace, setPaintSlot, editedRef, animEditsRef, resolved, setEditedImages, setAnimations, pixelStep, animationStep } = m;
  const { activeSlot } = paintTarget;
  const { assignTexture } = paintTextures;
  const { stroke, beginPaint, movePaint, endPaint } = paintStrokes;
  const editAnimation = (key: string, animation: TextureAnimation, img?: PixelImage) =>
    documentAction(path, () => {
      if (img) {
        pixelStep(key, editedRef.current[key]?.img ?? null, img);
        setEditedImages({ [key]: img });
      }
      animationStep(key, animEditsRef.current[key] ?? null, { animation });
      setAnimations({ [key]: { animation } });
    });

  const onCanvasPaint = (x: number, y: number, phase: PaintPhase, mods: PaintModifiers) => {
    if (phase === "down") activeSlot && beginPaint(activeSlot, x, y, mods.alt);
    else if (phase === "move") movePaint(x, y);
    else endPaint();
  };

  const onViewportPaint = (hit: PaintHit | null, phase: "down" | "move" | "up", alt: boolean) => {
    if (phase === "down") {
      if (!hit) return;
      if (hit.element !== null) {
        setSelected(hit.element);
        setFace(hit.face);
      }
      setPaintSlot(hit.slot);
      beginPaint(hit.slot, hit.x, hit.y, alt);
    } else if (phase === "move") {
      if (hit && hit.slot === stroke.current?.slot) movePaint(hit.x, hit.y);
    } else endPaint();
  };

  const newTexture = async () => {
    const slot = activeSlot ?? (resolved.sprite ? "layer0" : resolved.slots[0]);
    if (!slot) return;
    const r = await showDialog({
      title: t("New Texture"),
      message: t("A blank texture for the {slot} slot, saved in the mod's resources/ with the file.", { slot }),
      buttons: [
        { id: "cancel", label: t("Cancel") },
        { id: "16", label: "16×16", variant: "primary" },
        { id: "32", label: "32×32" },
        { id: "64", label: "64×64" },
      ],
    });
    const n = Number(r.button);
    if (!n) return;
    assignTexture(slot, blankImage(n, n));
    setPaintSlot(slot);
  };

  return { editAnimation, onCanvasPaint, onViewportPaint, newTexture };
}

/** What `usePaintInput` gives. */
export type PaintInput = ReturnType<typeof usePaintInput>;
