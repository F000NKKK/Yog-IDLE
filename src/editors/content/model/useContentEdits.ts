// Edits: the file's text, painted pixels and animations, each an undo step.

import { useCallback, useEffect } from "react";
import { type EditorProps, notifyDocumentCommands, pushDocumentStep } from "substrate-platform-ui";
import type { ContentFile, Element, Model } from "../../../content/model";
import { type PixelImage, toPngDataUrl } from "../../../content/paint/pixels";
import { type AnimationEdit, editModelElements, ensureModel } from "../contentModel";
import type { ContentDocument } from "./useContentDocument";
import type { PaintBuffers } from "./usePaintBuffers";
import type { ResolvedModel } from "./useResolvedModel";

/** Edits: the file's text, painted pixels and animations, each an undo step. */
export function useContentEdits(props: EditorProps, contentDocument: ContentDocument, paintBuffers: PaintBuffers, resolvedModel: ResolvedModel) {
  const { path, contentVersion } = props;
  const { updateFile, setImages, parents } = contentDocument;
  const { setEdited, setSaved, editedRef, setAnimEdits, animEditsRef } = paintBuffers;
  const { effectiveKey, resolved } = resolvedModel;
  // ── Edits — Undo/Redo are the platform's (`documentHistory`): the file's
  // text is recorded as it changes, painted pixels and animations as steps.

  useEffect(() => {
    setImages({});
    setEdited({});
    setSaved({});
    setAnimEdits({});
    notifyDocumentCommands();
  }, [contentVersion]);

  /** Sets painted textures (`null`: back to what's on disk / gone). */
  const setEditedImages = useCallback((patch: Record<string, PixelImage | null>) => {
    const next = { ...editedRef.current };
    for (const [k, img] of Object.entries(patch)) {
      if (img) next[k] = { img, url: toPngDataUrl(img) };
      else delete next[k];
    }
    editedRef.current = next;
    setEdited(next);
  }, []);

  /** Changes the file; resolves once it's written (an undo step waits for it). */
  const update = useCallback(
    (edit: (draft: ContentFile) => void) =>
      updateFile((d) => {
        edit(d);
      }),
    [updateFile]
  );

  /** Sets edited animations (`null`: back to the loaded one). */
  const setAnimations = useCallback((patch: Record<string, AnimationEdit>) => {
    const next = { ...animEditsRef.current };
    for (const [k, v] of Object.entries(patch)) {
      if (v) next[k] = v;
      else delete next[k];
    }
    animEditsRef.current = next;
    setAnimEdits(next);
  }, []);

  /** An undoable step: texture `key`'s pixels from `before` to `after` (`null`: not painted here). */
  const pixelStep = useCallback(
    (key: string, before: PixelImage | null, after: PixelImage | null) =>
      pushDocumentStep(path, { undo: () => setEditedImages({ [key]: before }), redo: () => setEditedImages({ [key]: after }) }),
    [path, setEditedImages]
  );
  /** An undoable step: texture `key`'s animation from `before` to `after`. */
  const animationStep = useCallback(
    (key: string, before: AnimationEdit, after: AnimationEdit) =>
      pushDocumentStep(path, { undo: () => setAnimations({ [key]: before }), redo: () => setAnimations({ [key]: after }) }),
    [path, setAnimations]
  );

  /** Edits the current model's own elements (copying a template's/parent's in first). */
  const editElements = useCallback(
    (edit: (els: Element[], m: Model) => void) =>
      update((d) => editModelElements(ensureModel(d, effectiveKey), resolved.elements, parents, edit)),
    [update, effectiveKey, resolved, parents]
  );

  return { setEditedImages, update, setAnimations, pixelStep, animationStep, editElements };
}

/** What `useContentEdits` gives. */
export type ContentEdits = ReturnType<typeof useContentEdits>;
