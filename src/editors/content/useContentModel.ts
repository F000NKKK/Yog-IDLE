// The file, the model edited, what's selected and shown, and the edits — the .yblock/.yitem editor's state.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type EditorProps, notifyDocumentCommands, pushDocumentStep, reportError, useContextMenu, useT } from "substrate-platform-ui";
import { useOpenFiles } from "../../OpenFilesContext";
import { cli } from "../../cli";
import type { GizmoMode, ViewName } from "../../content/Viewport";
import { clone, CONTENT_FORMAT, type ContentFile, type Dir, type DisplaySlot, type Element, kindOf, type Model, templateOf } from "../../content/model";
import { usePaintState } from "../../content/paint/PaintTools";
import { type PixelImage, toPngDataUrl } from "../../content/paint/pixels";
import { type BlockState, defaultState, stateProperties, variantOf } from "../../content/states";
import { useContentRefs } from "../../data/contentRefs";
import { useTyped } from "../../data/typed";
import { useDataFile } from "../../data/useDataFile";
import { type AnimationEdit, type BuiltInBlockKind, type Choices, type Edited, ensureModel, type LoadedTexture, type ModelKey, modelOf, NO_CHOICES, type ParentModel, resolve, stateModelKey, type StateSel } from "./contentModel";

/** The file, the model edited, what's selected and shown, and the edits — the .yblock/.yitem editor's state. */
export function useContentModel(props: EditorProps) {
  const { path, content, onChange, readOnly, contentVersion } = props;
  // Typed values (`@item:…`) classified by the CLI come in: draw again.
  useTyped();
  const t = useT();
  const { tabs, setView, setSideState } = useOpenFiles();
  const kind = kindOf(path) ?? "block";
  const { parsed, update: updateFile } = useDataFile(content, onChange, CONTENT_FORMAT, readOnly);
  const file = useMemo<ContentFile>(() => (parsed?.ok ? parsed.file : {}), [parsed]);

  const [modelKey, setModelKey] = useState<ModelKey>("model");
  const [selected, setSelected] = useState<number | null>(null);
  const [face, setFace] = useState<Dir | null>(null);
  const [gizmo, setGizmo] = useState<GizmoMode>("move");
  const [shading, setShading] = useState(true);
  const [grid, setGrid] = useState(true);
  const [displaySlot, setDisplaySlot] = useState<DisplaySlot | "">("");
  const [variant, setVariant] = useState(0);
  /** The block state the view shows (`null`: the model as it is, unturned) — its values over the default state's. */
  const [previewState, setPreviewState] = useState<BlockState | null>(null);
  /** What's picked in the outliner's States: a property, a state model or a variant. */
  const [stateSel, setStateSel] = useState<StateSel | null>(null);
  const stateMenu = useContextMenu<void>();
  const [viewRequest, setViewRequest] = useState<{ view: ViewName; key: number } | null>(null);
  const [images, setImages] = useState<Record<string, LoadedTexture | undefined>>({});
  const [parents, setParents] = useState<Record<string, ParentModel | null>>({});
  const [choices, setChoices] = useState<Choices>(NO_CHOICES);
  const [blockKinds, setBlockKinds] = useState<BuiltInBlockKind[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const blockRefs = useContentRefs(path, "block");
  const entityRefs = useContentRefs(path, "entity");
  const effectRefs = useContentRefs(path, "effect");

  useEffect(() => setPaintSlot(null), [path]);

  useEffect(() => {
    let live = true;
    cli<BuiltInBlockKind[]>("content_block_kinds")
      .then((kinds) => live && setBlockKinds(kinds))
      .catch((e) => live && reportError(t("Can't load built-in block kinds: {error}", { error: String(e) })));
    return () => {
      live = false;
    };
  }, [t]);

  // Paint mode: the textures' pixels, decoded from disk (`decoded`), painted
  // (`edited`), and as last saved (`saved`).
  const [paintMode, setPaintMode] = useState(false);
  const { state: paint, set: setPaint, used: usedColor } = usePaintState("yog.content.paint");
  const [paintSlot, setPaintSlot] = useState<string | null>(null);
  const [tints, setTints] = useState<Record<number, string>>({});
  const [decoded, setDecoded] = useState<Record<string, { url: string; img: PixelImage }>>({});
  const [edited, setEdited] = useState<Record<string, Edited>>({});
  const [saved, setSaved] = useState<Record<string, PixelImage>>({});
  const editedRef = useRef(edited);
  editedRef.current = edited;
  // Animations edited here (frames added, times changed), over the loaded
  // ones; which step of each is painted, and whether they play.
  const [animEdits, setAnimEdits] = useState<Record<string, AnimationEdit>>({});
  const animEditsRef = useRef(animEdits);
  animEditsRef.current = animEdits;
  const [paintEntry, setPaintEntry] = useState<Record<string, number>>({});
  const [playing, setPlaying] = useState(false);

  // A model key that no longer exists (the arm removed, say) → the main model.
  const effectiveKey: ModelKey = modelOf(file, modelKey) || modelKey === "model" ? modelKey : "model";
  const model = modelOf(file, effectiveKey);
  const modelKind = effectiveKey === "item_model" || kind === "item" ? "item" : "block";
  const resolved = useMemo(() => resolve(model, modelKind, parents), [model, modelKind, parents]);
  const mainResolved = useMemo(() => resolve(file.model, kind, parents), [file.model, kind, parents]);
  useEffect(() => {
    const firstLayer = resolved.sprite?.[0]?.slot;
    if (firstLayer && !resolved.slots.includes(paintSlot ?? "")) setPaintSlot(firstLayer);
  }, [resolved, paintSlot]);
  const potionEffects = JSON.stringify(file.item?.potion?.effects ?? []);
  const [potionTint, setPotionTint] = useState<string>();
  useEffect(() => {
    if (kind !== "item" || !file.item?.potion) {
      setPotionTint(undefined);
      return;
    }
    let live = true;
    void cli<number | null>("content_item_potion_color", { path })
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

  // Block states: every property, the state shown, what's picked.
  const states = file.states;
  const stateProps = useMemo(() => (kind === "block" ? stateProperties(states) : []), [kind, states]);
  const shownState = useMemo<BlockState | null>(() => {
    if (!previewState || !stateProps.length) return null;
    const st = defaultState(stateProps);
    for (const p of stateProps) if (previewState[p.name] !== undefined && p.values.includes(previewState[p.name])) st[p.name] = previewState[p.name];
    return st;
  }, [previewState, stateProps]);
  const shownVariant = useMemo(() => (shownState ? variantOf(states, shownState) : null), [shownState, states]);
  /** The model a variant's first model name is (the block's own when it names none or one that isn't there). */
  const variantModelKey = (models: string[]): ModelKey => (models[0] && states?.models?.[models[0]] ? stateModelKey(models[0]) : "model");
  const pickedState: StateSel | null =
    stateSel &&
    ((stateSel.kind === "property" && states?.properties?.[stateSel.key]) ||
      (stateSel.kind === "model" && states?.models?.[stateSel.key]) ||
      (stateSel.kind === "variant" && states?.variants && stateSel.key in states.variants))
      ? stateSel
      : null;

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
      update((d) => {
        const m = ensureModel(d, effectiveKey);
        if (!m.elements?.length) {
          m.elements = clone(resolved.elements);
          if (m.parent && (templateOf(m.parent) || parents[m.parent])) {
            m.textures = { ...(parents[m.parent]?.textures ?? {}), ...(m.textures ?? {}) };
            delete m.parent;
          }
        }
        edit(m.elements, m);
      }),
    [update, effectiveKey, resolved, parents]
  );

  return { t, tabs, setView, setSideState, kind, parsed, updateFile, file, modelKey, setModelKey, selected, setSelected, face, setFace, gizmo, setGizmo, shading, setShading, grid, setGrid, displaySlot, setDisplaySlot, variant, setVariant, previewState, setPreviewState, stateSel, setStateSel, stateMenu, viewRequest, setViewRequest, images, setImages, parents, setParents, choices, setChoices, blockKinds, setBlockKinds, rootRef, blockRefs, entityRefs, effectRefs, paintMode, setPaintMode, paint, setPaint, usedColor, paintSlot, setPaintSlot, tints, setTints, decoded, setDecoded, edited, setEdited, saved, setSaved, editedRef, animEdits, setAnimEdits, animEditsRef, paintEntry, setPaintEntry, playing, setPlaying, effectiveKey, model, modelKind, resolved, mainResolved, potionEffects, potionTint, setPotionTint, previewTints, elements, sel, selEl, states, stateProps, shownState, shownVariant, variantModelKey, pickedState, setEditedImages, update, setAnimations, pixelStep, animationStep, editElements };
}

/** What `useContentModel` gives the editor. */
export type ContentModel = ReturnType<typeof useContentModel>;
