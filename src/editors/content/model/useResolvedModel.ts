// The model edited, resolved over its parents, the selected element, and the tints previewed.

import { useEffect, useMemo, useState } from "react";
import { type EditorProps, reportError } from "substrate-platform-ui";
import { cli } from "../../../cli";
import type { Kind } from "../../../content/model";
import { kind as KIND, serveMethod } from "../../../data/yogIds.generated";
import { MODEL, type ModelKey, modelOf, resolve } from "../contentModel";
import type { ContentDocument } from "./useContentDocument";
import type { PaintBuffers } from "./usePaintBuffers";

/** The model edited, resolved over its parents, the selected element, and the tints previewed. */
export function useResolvedModel(props: EditorProps, contentDocument: ContentDocument, paintBuffers: PaintBuffers) {
  const { path, contentVersion } = props;
  const { t, kind, file, modelKey, selected, parents } = contentDocument;
  const { paintSlot, setPaintSlot, tints } = paintBuffers;
  // A model key that no longer exists (the arm removed, say) → the main model.
  const effectiveKey: ModelKey = modelOf(file, modelKey) || modelKey === MODEL.main ? modelKey : MODEL.main;
  const model = modelOf(file, effectiveKey);
  const modelKind: Kind = effectiveKey === MODEL.item || kind === KIND.ITEM ? KIND.ITEM : KIND.BLOCK;
  const resolved = useMemo(() => resolve(model, modelKind, parents), [model, modelKind, parents]);
  const mainResolved = useMemo(() => resolve(file.model, kind, parents), [file.model, kind, parents]);
  useEffect(() => {
    const firstLayer = resolved.sprite?.[0]?.slot;
    if (firstLayer && !resolved.slots.includes(paintSlot ?? "")) setPaintSlot(firstLayer);
  }, [resolved, paintSlot]);
  const potionEffects = JSON.stringify(file.item?.potion?.effects ?? []);
  const [potionTint, setPotionTint] = useState<string>();
  useEffect(() => {
    if (kind !== KIND.ITEM || !file.item?.potion) {
      setPotionTint(undefined);
      return;
    }
    let live = true;
    void cli<number | null>(serveMethod.CONTENT_ITEM_POTION_COLOR, { path })
      .then((color) => {
        if (live) setPotionTint(color == null ? undefined : `#${color.toString(16).padStart(6, "0")}`);
      })
      .catch((e) => live && reportError(t("Can't load the potion's effect color: {error}", { error: String(e) })));
    return () => {
      live = false;
    };
  }, [path, kind, contentVersion, potionEffects, t]);
  const previewTints = useMemo(
    () => (potionTint ? { 0: potionTint, ...tints } : tints),
    [potionTint, tints],
  );
  const elements = resolved.elements;
  const sel = selected !== null && selected < elements.length ? selected : null;
  const selEl = sel !== null ? elements[sel] : undefined;

  return { effectiveKey, model, modelKind, resolved, mainResolved, potionEffects, potionTint, setPotionTint, previewTints, elements, sel, selEl };
}

/** What `useResolvedModel` gives. */
export type ResolvedModel = ReturnType<typeof useResolvedModel>;
