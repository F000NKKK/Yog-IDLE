// The file parsed, what the editor shows (model, selection, gizmo, view options), and the choices and references its pickers offer.

import { useEffect, useMemo, useRef, useState } from "react";
import { type EditorProps, reportError, useContextMenu, useT } from "substrate-platform-ui";
import { useOpenFiles } from "../../../OpenFilesContext";
import { cli } from "../../../cli";
import type { GizmoMode, ViewName } from "../../../content/Viewport";
import { CONTENT_FORMAT, type ContentFile, type Dir, type DisplaySlot, kindOf } from "../../../content/model";
import type { BlockState } from "../../../content/states";
import { useContentRefs } from "../../../data/contentRefs";
import { useTyped } from "../../../data/typed";
import { useDataFile } from "../../../data/useDataFile";
import { kind as KIND } from "../../../data/yogIds.generated";
import { type BuiltInBlockKind, type Choices, type LoadedTexture, MODEL, type ModelKey, NO_CHOICES, type ParentModel, type StateSel } from "../contentModel";

/** The file parsed, what the editor shows (model, selection, gizmo, view options), and the choices and references its pickers offer. */
export function useContentDocument(props: EditorProps) {
  const { path, content, onChange, readOnly } = props;
  // Typed values (`@item:…`) classified by the CLI come in: draw again.
  useTyped();
  const t = useT();
  const { tabs, setView, setSideState } = useOpenFiles();
  const kind = kindOf(path) ?? KIND.BLOCK;
  const { parsed, update: updateFile } = useDataFile(content, onChange, CONTENT_FORMAT, readOnly);
  const file = useMemo<ContentFile>(() => (parsed?.ok ? parsed.file : {}), [parsed]);

  const [modelKey, setModelKey] = useState<ModelKey>(MODEL.main);
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
  const blockRefs = useContentRefs(path, KIND.BLOCK);
  const entityRefs = useContentRefs(path, KIND.ENTITY);
  const effectRefs = useContentRefs(path, KIND.EFFECT);

  useEffect(() => {
    let live = true;
    cli<BuiltInBlockKind[]>("content_block_kinds")
      .then((kinds) => live && setBlockKinds(kinds))
      .catch((e) => live && reportError(t("Can't load built-in block kinds: {error}", { error: String(e) })));
    return () => {
      live = false;
    };
  }, [t]);

  return { t, tabs, setView, setSideState, kind, parsed, updateFile, file, modelKey, setModelKey, selected, setSelected, face, setFace, gizmo, setGizmo, shading, setShading, grid, setGrid, displaySlot, setDisplaySlot, variant, setVariant, previewState, setPreviewState, stateSel, setStateSel, stateMenu, viewRequest, setViewRequest, images, setImages, parents, setParents, choices, setChoices, blockKinds, setBlockKinds, rootRef, blockRefs, entityRefs, effectRefs };
}

/** What `useContentDocument` gives. */
export type ContentDocument = ReturnType<typeof useContentDocument>;
