// A block's states: every property, the state shown and the variant showing it, what's picked.

import { useMemo } from "react";
import { type BlockState, defaultState, stateProperties, variantOf } from "../../../content/states";
import { kind as KIND } from "../../../data/yogIds.generated";
import { MODEL, type ModelKey, STATE_PICK, stateModelKey, type StateSel } from "../contentModel";
import type { ContentDocument } from "./useContentDocument";

/** A block's states: every property, the state shown and the variant showing it, what's picked. */
export function useBlockStates(contentDocument: ContentDocument) {
  const { kind, file, previewState, stateSel } = contentDocument;
  // Block states: every property, the state shown, what's picked.
  const states = file.states;
  const stateProps = useMemo(() => (kind === KIND.BLOCK ? stateProperties(states) : []), [kind, states]);
  const shownState = useMemo<BlockState | null>(() => {
    if (!previewState || !stateProps.length) return null;
    const st = defaultState(stateProps);
    for (const p of stateProps) if (previewState[p.name] !== undefined && p.values.includes(previewState[p.name])) st[p.name] = previewState[p.name];
    return st;
  }, [previewState, stateProps]);
  const shownVariant = useMemo(() => (shownState ? variantOf(states, shownState) : null), [shownState, states]);
  /** The model a variant's first model name is (the block's own when it names none or one that isn't there). */
  const variantModelKey = (models: string[]): ModelKey => (models[0] && states?.models?.[models[0]] ? stateModelKey(models[0]) : MODEL.main);
  const pickedState: StateSel | null =
    stateSel &&
    ((stateSel.kind === STATE_PICK.property && states?.properties?.[stateSel.key]) ||
      (stateSel.kind === STATE_PICK.model && states?.models?.[stateSel.key]) ||
      (stateSel.kind === STATE_PICK.variant && states?.variants && stateSel.key in states.variants))
      ? stateSel
      : null;

  return { states, stateProps, shownState, shownVariant, variantModelKey, pickedState };
}

/** What `useBlockStates` gives. */
export type BlockStates = ReturnType<typeof useBlockStates>;
