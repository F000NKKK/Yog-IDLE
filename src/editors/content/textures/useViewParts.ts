// What the view draws: the parts (turned as the block stands), the display transform, and selection and moves from it.

import { useCallback, useMemo } from "react";
import type { Part } from "../../../content/Viewport";
import type { Dir, Vec3 } from "../../../content/model";
import { MODEL, stateModelOf } from "../contentModel";
import type { ContentModel } from "../useContentModel";

/** What the view draws: the parts (turned as the block stands), the display transform, and selection and moves from it. */
export function useViewParts(m: ContentModel) {
  const { file, setSelected, setFace, displaySlot, variant, setStateSel, effectiveKey, resolved, mainResolved, previewTints, shownVariant, editElements } = m;
  // ── What the view draws ───────────────────────────────────────────────────

  const rotations = file.states?.rotations ?? [];
  const turnsWithState = effectiveKey === MODEL.main || stateModelOf(effectiveKey) !== null;
  const rot = shownVariant && turnsWithState ? shownVariant : effectiveKey === MODEL.main ? rotations[variant] : undefined;
  const parts = useMemo<Part[]>(() => {
    const own: Part = {
      elements: resolved.elements,
      textures: resolved.textures,
      sprite: resolved.sprite,
      tints: previewTints,
      editable: true,
      x: rot?.x,
      y: rot?.y,
    };
    if (effectiveKey !== MODEL.arm) return [own];
    return [{ elements: mainResolved.elements, textures: mainResolved.textures, sprite: mainResolved.sprite, ghost: true }, own];
  }, [resolved, mainResolved, effectiveKey, rot, previewTints]);

  const display = useMemo(() => {
    if (!displaySlot) return null;
    return { slot: displaySlot, transform: resolved.display[displaySlot] ?? {} };
  }, [displaySlot, resolved]);

  const onSelect = useCallback((el: number | null, f: Dir | null) => {
    setSelected(el);
    setFace(f);
    if (el !== null) setStateSel(null);
  }, []);

  const onTransform = useCallback(
    (index: number, from: Vec3, to: Vec3) =>
      editElements((els) => {
        els[index].from = from;
        els[index].to = to;
      }),
    [editElements]
  );

  return { rotations, turnsWithState, rot, parts, display, onSelect, onTransform };
}

/** What `useViewParts` gives. */
export type ViewParts = ReturnType<typeof useViewParts>;
