// The file, the model edited, what's selected and shown, and the edits — the .yblock/.yitem editor's state.

import { type EditorProps } from "substrate-platform-ui";
import { useContentDocument } from "./model/useContentDocument";
import { usePaintBuffers } from "./model/usePaintBuffers";
import { useResolvedModel } from "./model/useResolvedModel";
import { useBlockStates } from "./model/useBlockStates";
import { useContentEdits } from "./model/useContentEdits";

/** The file, the model edited, what's selected and shown, and the edits — the .yblock/.yitem editor's state. */
export function useContentModel(props: EditorProps) {
  const contentDocument = useContentDocument(props);
  const paintBuffers = usePaintBuffers(props);
  const resolvedModel = useResolvedModel(props, contentDocument, paintBuffers);
  const blockStates = useBlockStates(contentDocument);
  const contentEdits = useContentEdits(props, contentDocument, paintBuffers, resolvedModel);
  const { t, tabs, setView, setSideState, kind, parsed, updateFile, file, modelKey, setModelKey, selected, setSelected, face, setFace, gizmo, setGizmo, shading, setShading, grid, setGrid, displaySlot, setDisplaySlot, variant, setVariant, previewState, setPreviewState, stateSel, setStateSel, stateMenu, viewRequest, setViewRequest, images, setImages, parents, setParents, choices, setChoices, blockKinds, setBlockKinds, rootRef, blockRefs, entityRefs, effectRefs } = contentDocument;
  const { paintMode, setPaintMode, paint, setPaint, usedColor, paintSlot, setPaintSlot, tints, setTints, decoded, setDecoded, edited, setEdited, saved, setSaved, editedRef, animEdits, setAnimEdits, animEditsRef, paintEntry, setPaintEntry, playing, setPlaying } = paintBuffers;
  const { effectiveKey, model, modelKind, resolved, mainResolved, potionEffects, potionTint, setPotionTint, previewTints, elements, sel, selEl } = resolvedModel;
  const { states, stateProps, shownState, shownVariant, variantModelKey, pickedState } = blockStates;
  const { setEditedImages, update, setAnimations, pixelStep, animationStep, editElements } = contentEdits;
  return { t, tabs, setView, setSideState, kind, parsed, updateFile, file, modelKey, setModelKey, selected, setSelected, face, setFace, gizmo, setGizmo, shading, setShading, grid, setGrid, displaySlot, setDisplaySlot, variant, setVariant, previewState, setPreviewState, stateSel, setStateSel, stateMenu, viewRequest, setViewRequest, images, setImages, parents, setParents, choices, setChoices, blockKinds, setBlockKinds, rootRef, blockRefs, entityRefs, effectRefs, paintMode, setPaintMode, paint, setPaint, usedColor, paintSlot, setPaintSlot, tints, setTints, decoded, setDecoded, edited, setEdited, saved, setSaved, editedRef, animEdits, setAnimEdits, animEditsRef, paintEntry, setPaintEntry, playing, setPlaying, effectiveKey, model, modelKind, resolved, mainResolved, potionEffects, potionTint, setPotionTint, previewTints, elements, sel, selEl, states, stateProps, shownState, shownVariant, variantModelKey, pickedState, setEditedImages, update, setAnimations, pixelStep, animationStep, editElements };
}

/** What `useContentModel` gives the editor. */
export type ContentModel = ReturnType<typeof useContentModel>;
