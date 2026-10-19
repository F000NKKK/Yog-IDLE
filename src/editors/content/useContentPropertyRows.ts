// The Properties rows: the file's (general, block, item), its states', and
// the model's and selected element's — or a picked state item's alone.

import { useMemo } from "react";
import type { PropertyDescriptor } from "substrate-platform-ui";
import { kind as KIND } from "../../data/yogIds.generated";
import { STATE_PICK } from "./contentModel";
import { blockItemRows } from "./properties/blockItem";
import type { PropertiesContext } from "./properties/context";
import { generalRows } from "./properties/general";
import { modelRows } from "./properties/model";
import { propertyRows } from "./properties/rows";
import { stateRows } from "./properties/states";
import type { StatePicking } from "./stateCommands";
import type { ContentModel } from "./useContentModel";
import type { ContentPaint } from "./useContentPaint";

/** The rows of a picked property, state model or variant (`sp.`, `sm.`, `sv.`). */
const STATE_ITEM_ROW = /^s[pmv]\./;

export function useContentPropertyRows(readOnly: boolean | undefined, m: ContentModel, pt: ContentPaint, { editStates, stateModelNames }: StatePicking): PropertyDescriptor[] {
  const { t, kind, file, modelKey, setModelKey, face, displaySlot, setPreviewState, setStateSel, choices, blockKinds, blockRefs, entityRefs, effectRefs, effectiveKey, model, modelKind, resolved, mainResolved, sel, selEl, states, stateProps, pickedState, update, editElements } = m;
  const { shownImages } = pt;
  return useMemo<PropertyDescriptor[]>(() => {
    const out: PropertyDescriptor[] = [];
    const ctx: PropertiesContext = {
      ...propertyRows(file, readOnly),
      file, kind, update, choices, blockKinds, blockRefs, effectRefs, entityRefs, readOnly,
      editStates, effectiveKey, modelKey, mainResolved, resolved, pickedState, setModelKey, setPreviewState, setStateSel,
      stateModelNames, stateProps, states, displaySlot, editElements, face, model, modelKind, sel, selEl, shownImages,
    };
    generalRows(ctx, out);
    blockItemRows(ctx, out);
    stateRows(ctx, out);
    modelRows(ctx, out);
    // A picked property, state model or variant is the object shown: its rows (a model's with its model's).
    if (kind === KIND.BLOCK && pickedState && states) {
      const fileCategories = new Set([t("General"), t("Block"), t("Item"), t("States")]);
      return out.filter((r) => !fileCategories.has(r.category ?? "") && (pickedState.kind === STATE_PICK.model || STATE_ITEM_ROW.test(r.id)));
    }
    return out;
    // `t` and the helpers read fresh state each render.
  }, [file, kind, model, resolved, mainResolved, shownImages, choices, blockKinds, blockRefs, entityRefs, effectRefs, displaySlot, selEl, sel, face, readOnly, effectiveKey, modelKey, modelKind, pickedState, stateProps]);
}
