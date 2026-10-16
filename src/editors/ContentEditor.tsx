import { cropFrame, pasteFrame, sameAnimation, stillAnimation, type TextureAnimation } from "../content/animation";
import { FrameStrip } from "../content/paint/FrameStrip";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Button,
  confirmDialog,
  ContextMenu,
  type ContextMenuItem,
  useContextMenu,
  Icon,
  IconButton,
  notify,
  notifyDocumentCommands,
  usePropertyContext,
  pushDocumentStep,
  documentAction,
  Toolbar,
  ToolbarButton,
  ToolbarCheck,
  ToolbarGroup,
  ToolbarModes,
  ToolbarSelect,
  promptDialog,
  registerDocumentCommands,
  SelectField,
  showDialog,
  useKeybinding,
  useT,
  type EditorProps,
  type PropertyDescriptor,
  withShortcut,
  pt,
  stemOf,
  Spacer,
} from "substrate-platform-ui";
import { belowButton } from "../git/dropdown";
import { useOpenFiles } from "../OpenFilesContext";
import { reportError } from "../reportError";
import { refMessage } from "./inspector";
import { refProblem, refSuggestions, useContentRefs } from "../data/contentRefs";
import { RowsEditor } from "./RowsEditor";
import {
  ANGLES,
  autoUv,
  clone,
  defaultDisplay,
  DIRS,
  DISPLAY_SLOTS,
  kindOf,
  parseContent,
  patchContent,
  RENDER_LAYERS,
  serializeContent,
  templateElements,
  templateOf,
  TEMPLATES,
  TOOL_LEVELS,
  TOOLS,
  TOOL_KINDS,
  ARMOR_SLOTS,
  FACINGS,
  FACING_LABELS,
  PLACEMENTS,
  type ArmorSlot,
  type Axis,
  type ContentFile,
  type Dir,
  type DisplaySlot,
  type DisplayTransform,
  type Element,
  type Model,
  type StateRotation,
  type Uv,
  type Vec3,
} from "../content/model";
import {
  defaultState,
  freeName,
  isWord,
  modelNames,
  modelNamesValue,
  moveVariant,
  newVariantKey,
  parseVariantKey,
  PROPERTY_KIND_LABELS,
  PROPERTY_KINDS,
  propertyKind,
  propertyNameProblem,
  rangeValues,
  removeModel,
  removeProperty,
  renameModel,
  renameProperty,
  setVariantKey,
  stateCount,
  stateModelFrom,
  stateProperties,
  statesShowing,
  valuesProblem,
  variantKey,
  variantOf,
  variantProblems,
  withDefault,
  YES_NO,
  type BlockState,
  type PropertyKind,
  type States,
} from "../content/states";
import { UvEditor } from "../content/UvEditor";
import { Viewport, type GizmoMode, type PaintHit, type Part, type TextureSource, type ViewName } from "../content/Viewport";
import { PaintCanvas, type PaintModifiers, type PaintPhase } from "../content/paint/PaintCanvas";
import { PaintTools, usePaintState } from "../content/paint/PaintTools";
import { blankImage, cloneImage, decodeImage, getPixel, sameImage, Stroke, toPngDataUrl, type PixelImage } from "../content/paint/pixels";
import { spriteLayerElements } from "../content/spriteElements";
import "./ContentEditor.css";

/** What the pickers offer, from the mod and the game. */
interface Choices {
  textures: string[];
  strings: string[];
  sounds: string[];
  tags: string[];
  toolMaterials: string[];
  armorMaterials: string[];
}
const NO_CHOICES: Choices = { textures: [], strings: [], sounds: [], tags: [], toolMaterials: [], armorMaterials: [] };

interface BuiltInBlockKind {
  name: string;
  takes: string[];
  occludes?: boolean;
}

interface PotionEffectRow extends Record<string, unknown> {
  effect?: string;
  duration?: number;
  amplifier?: number;
}


export const CONTENT_SOURCE_VIEW = "yog.content.source";

/** Which model of the file is being edited: the block's or item's, its item form's, the connection arm, or a state model (`states.models`). */
type ModelKey = "model" | "item_model" | "arm" | `state:${string}`;

const STATE_MODEL = "state:";
const stateModelKey = (name: string): ModelKey => `${STATE_MODEL}${name}`;
/** The state model's name a key stands for, if it's one. */
const stateModelOf = (key: ModelKey): string | null => (key.startsWith(STATE_MODEL) ? key.slice(STATE_MODEL.length) : null);

/** A raw parent model (`content_parent_model`), parents flattened. */
interface ParentModel {
  textures?: Record<string, string>;
  elements?: Element[];
  display?: Partial<Record<DisplaySlot, DisplayTransform>>;
  parent?: string;
}

/** A model as drawn: its elements (own, a template's, or a parent's), textures resolved, display. */
interface Resolved {
  elements: Element[];
  /** Slot → texture value (`#refs` followed). */
  textures: Record<string, string>;
  /** Slots this model can use (its own and inherited), for pickers. */
  slots: string[];
  /** An item sprite: its layers (`layer0`, …) with textures, in order. */
  sprite?: { slot: string; texture: string }[];
  /** The elements are the model's own (editable). */
  own: boolean;
  display: Partial<Record<DisplaySlot, DisplayTransform>>;
}

const isSpriteParent = (p?: string) => !!p && /(^|[:/])(generated|handheld)$|builtin\/generated/.test(p);

function modelOf(f: ContentFile, key: ModelKey): Model | undefined {
  if (key === "arm") return f.states?.connect?.arm;
  const state = stateModelOf(key);
  if (state !== null) return f.states?.models?.[state];
  return f[key as "model" | "item_model"];
}

function ensureModel(f: ContentFile, key: ModelKey): Model {
  if (key === "arm") {
    f.states ??= {};
    f.states.connect ??= { arm: {} };
    return f.states.connect.arm;
  }
  const state = stateModelOf(key);
  if (state !== null) {
    f.states ??= {};
    f.states.models ??= {};
    return (f.states.models[state] ??= {});
  }
  return (f[key as "model" | "item_model"] ??= {});
}

/** Every model of the file: the block's or item's, the item form's, the arm, the state models. */
const allModels = (f: ContentFile): (Model | undefined)[] => [f.model, f.item_model, f.states?.connect?.arm, ...Object.values(f.states?.models ?? {})];

function resolve(model: Model | undefined, kind: "block" | "item", parents: Record<string, ParentModel | null>): Resolved {
  const m = model ?? {};
  const parent = m.parent;
  const tpl = templateOf(parent);
  const raw = parent && !tpl ? parents[parent] : undefined;
  const textures: Record<string, string> = { ...(raw?.textures ?? {}), ...(m.textures ?? {}) };
  const follow = (v: string | undefined): string | undefined => {
    for (let i = 0; i < 16 && v?.startsWith("#"); i++) v = textures[v.slice(1)];
    return v?.startsWith("#") ? undefined : v;
  };
  const resolved: Record<string, string> = {};
  for (const k of Object.keys(textures)) {
    const v = follow(textures[k]);
    if (v) resolved[k] = v;
  }
  const slots = [...new Set([...(tpl?.slots ?? []), ...Object.keys(textures)])];
  const spriteLayers = () =>
    Object.keys(textures)
      .filter((k) => /^layer\d+$/.test(k))
      .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
      .filter((k) => !!resolved[k])
      .map((slot) => ({ slot, texture: resolved[slot] }));
  let display: Resolved["display"];
  if (tpl?.sprite) display = defaultDisplay(parent === "handheld" ? "handheld" : "generated");
  else if (raw) display = raw.display ?? {};
  else if (kind === "item" && !m.elements?.length && !tpl) display = defaultDisplay("generated");
  else display = defaultDisplay("block");
  display = { ...display, ...(m.display ?? {}) };
  if (m.elements?.length) return { elements: m.elements, textures: resolved, slots, own: true, display };
  if (tpl?.sprite || (raw && !raw.elements && isSpriteParent(raw.parent)))
    return { elements: [], textures: resolved, slots: slots.length ? slots : ["layer0"], sprite: spriteLayers(), own: false, display };
  if (tpl) return { elements: templateElements(tpl.name) ?? [], textures: resolved, slots, own: false, display };
  if (raw?.elements) return { elements: raw.elements, textures: resolved, slots, own: false, display };
  // No elements yet — an empty, editable model.
  return { elements: [], textures: resolved, slots, own: !parent, display };
}

/** What's picked in the outliner's States. */
interface StateSel {
  kind: "property" | "model" | "variant";
  /** The property's, model's name; the variant's key. */
  key: string;
}

/** What the picked item is, for Properties' object line (translated). */
const STATE_SEL_TYPES: Record<StateSel["kind"], string> = { property: "State Property", model: "State Model", variant: "Variant" };

/** A texture as loaded: its image, and whether it's the mod's own file (paintable in place). */
type LoadedTexture = TextureSource & { writable: boolean };

/** A texture's animation as edited here: `null` = no override (the loaded one shows). */
type AnimationEdit = { animation: TextureAnimation | null } | null;



/** A texture painted in the editor (not saved yet, or saved and still shown from memory). */
interface Edited {
  img: PixelImage;
  url: string;
}

const LAYER = /^layer(\d+)$/;
const layerIndex = (slot: string) => Number(LAYER.exec(slot)?.[1] ?? -1);

/** Every texture value the file's models name. */
function namedTextures(f: ContentFile): Set<string> {
  const out = new Set<string>();
  for (const m of allModels(f)) for (const v of Object.values(m?.textures ?? {})) out.add(v);
  return out;
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
const vecText = (v: readonly number[] | undefined) => (v ? v.map(fmt).join(", ") : "");

/** `n` numbers from `1, 2, 3` — or what's wrong: `"count"` (not `n` numbers) or `"range"`. */
function parseVec(text: string, n: number, min = -Infinity, max = Infinity): number[] | "count" | "range" {
  const parts = text.split(/[,\s]+/).filter(Boolean).map(Number);
  if (parts.length !== n || parts.some((x) => Number.isNaN(x))) return "count";
  if (parts.some((x) => x < min || x > max)) return "range";
  return parts;
}

/** `0,90; 90,0` ↔ rotations. */
const rotationsText = (r: StateRotation[] | undefined) => (r ?? []).map((x) => `${x.x ?? 0},${x.y ?? 0}${x.weight ? `*${x.weight}` : ""}`).join("; ");
function parseRotations(text: string): StateRotation[] | string {
  const out: StateRotation[] = [];
  for (const part of text.split(";").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*,\s*(\d+)(?:\s*\*\s*(\d+))?$/.exec(part);
    if (!m) return "x,y pairs separated by ;, e.g. 0,0; 0,90; 0,180; 0,270";
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (![0, 90, 180, 270].includes(x) || ![0, 90, 180, 270].includes(y)) return "angles must be 0, 90, 180 or 270";
    out.push({ ...(x ? { x } : {}), ...(y ? { y } : {}), ...(m[3] ? { weight: Number(m[3]) } : {}) });
  }
  return out;
}

const ARM_TEMPLATE = (texture: string): Model => ({
  textures: { arm: texture },
  elements: [
    {
      from: [6, 6, 0],
      to: [10, 10, 6],
      faces: Object.fromEntries(DIRS.filter((d) => d !== "south").map((d) => [d, { texture: "#arm", ...(d === "north" ? { cullface: "north" as Dir } : {}) }])),
    },
  ],
});

/**
 * The `.yblock` / `.yitem` editor: the block's or item's 3D model in a
 * Blender-like view (Viewport), an outliner of its elements, its properties
 * (the block/item metadata, the model, the selected element and face, display
 * transforms, block states) in a Properties grid, and a UV editor for the
 * selected face. A block's states — its own properties, its state models and
 * the variants picking them — are listed under the elements; the toolbar's
 * State picks the state the view shows (its model, turned as it stands).
 * Every edit patches the file's text through `onChange` (what didn't change,
 * comments too, stays as written) — dirty state, Save and external reload as
 * for any file; undo/redo steps over the file's text; F7 opens the JSON.
 */
export function ContentEditor({ path, content, onChange, readOnly, contentVersion }: EditorProps) {
  const t = useT();
  const { tabs, setView, setSideState } = useOpenFiles();
  const kind = kindOf(path) ?? "block";
  const parsed = useMemo(() => parseContent(content), [content]);
  const file = useMemo<ContentFile>(() => (parsed.ok ? parsed.file : {}), [parsed]);

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

  useEffect(() => {
    let live = true;
    invoke<BuiltInBlockKind[]>("content_block_kinds")
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

  const contentRef = useRef(content);
  contentRef.current = content;
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

  const update = useCallback(
    (edit: (draft: ContentFile) => void) => {
      if (readOnly || !parsed.ok) return;
      const draft = clone(parsed.file);
      edit(draft);
      const text = patchContent(contentRef.current, draft);
      if (text === contentRef.current) return;
      onChange(text);
    },
    [onChange, readOnly, parsed]
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

  // ── Pickers' choices, parent models, textures ─────────────────────────────

  useEffect(() => {
    let live = true;
    void Promise.all([
      invoke<{ value: string }[]>("content_textures", { path }).catch(() => []),
      invoke<string[]>("content_strings", { path }).catch(() => []),
      invoke<string[]>("content_sound_groups", { path }).catch(() => []),
      invoke<string[]>("content_tags", { path, registry: kindOf(path) ?? "item" }).catch(() => []),
      invoke<string[]>("content_tool_materials", { path }).catch(() => []),
      invoke<string[]>("content_armor_materials", { path }).catch(() => []),
    ]).then(
      ([tex, strings, sounds, tags, toolMaterials, armorMaterials]) =>
        live && setChoices({ textures: tex.map((c) => c.value), strings, sounds, tags, toolMaterials, armorMaterials })
    );
    return () => {
      live = false;
    };
  }, [path, contentVersion]);

  const rawParents = useMemo(() => {
    const ids = new Set<string>();
    for (const m of allModels(file)) if (m?.parent && !templateOf(m.parent)) ids.add(m.parent);
    return [...ids];
  }, [file]);
  useEffect(() => {
    for (const id of rawParents) {
      if (id in parents) continue;
      setParents((p) => ({ ...p, [id]: null }));
      invoke<ParentModel>("content_parent_model", { path, id })
        .then((m) => setParents((p) => ({ ...p, [id]: m })))
        .catch((e) => reportError(t("Can't load the parent model {id}: {error}", { id, error: String(e) })));
    }
  }, [rawParents, parents, path, t]);

  const wanted = useMemo(() => {
    const v = new Set<string>();
    for (const r of [resolved, mainResolved]) {
      for (const x of Object.values(r.textures)) v.add(x);
      for (const x of r.sprite ?? []) v.add(x.texture);
    }
    return [...v];
  }, [resolved, mainResolved]);
  const requested = useRef(new Set<string>());
  useEffect(() => {
    requested.current = new Set();
  }, [contentVersion]);
  useEffect(() => {
    for (const value of wanted) {
      if (requested.current.has(value)) continue;
      requested.current.add(value);
      invoke<LoadedTexture>("content_texture", { path, texture: value })
        .then((src) => setImages((m) => ({ ...m, [value]: src })))
        .catch(() => setImages((m) => ({ ...m, [value]: undefined })));
    }
  }, [wanted, path, images]);

  // ── Painted textures: pixels, dirty state, Save, external changes ─────────

  const decoding = useRef(new Set<string>());
  useEffect(() => {
    for (const [key, src] of Object.entries(images)) {
      if (!src || decoded[key]?.url === src.url || decoding.current.has(src.url)) continue;
      decoding.current.add(src.url);
      decodeImage(src.url)
        .then((img) => setDecoded((d) => ({ ...d, [key]: { url: src.url, img } })))
        .catch(() => {})
        .finally(() => decoding.current.delete(src.url));
    }
  }, [images, decoded]);

  /** A texture's pixels as shown (painted, else as on disk). */
  const pixelsOf = (key: string | undefined): PixelImage | undefined => (key ? (edited[key]?.img ?? decoded[key]?.img) : undefined);

  const named = useMemo(() => namedTextures(file), [file]);
  /** Painted textures that differ from the file (new ones only while the file still names them). */
  const dirtyKeys = useMemo(
    () =>
      Object.keys(edited).filter((k) => {
        const base = saved[k] ?? decoded[k]?.img;
        return base ? !sameImage(edited[k].img, base) : named.has(k);
      }),
    [edited, saved, decoded, named]
  );

  /** A texture's animation as shown: edited here, else as loaded. */
  const animOf = (key: string | undefined): TextureAnimation | null =>
    key ? (animEdits[key] ? animEdits[key]!.animation : (images[key]?.animation ?? null)) : null;
  /** Animations changed here and not saved. */
  const animDirtyKeys = useMemo(
    () => Object.keys(animEdits).filter((k) => !sameAnimation(animEdits[k]?.animation, images[k]?.animation)),
    [animEdits, images]
  );

  const saveState = useRef({ dirtyKeys, edited, images, animDirtyKeys, animEdits });
  saveState.current = { dirtyKeys, edited, images, animDirtyKeys, animEdits };
  const saveTextures = useCallback(async () => {
    const { dirtyKeys: keys, edited: cur, animDirtyKeys: animKeys, animEdits: anims } = saveState.current;
    const written: Record<string, Edited> = {};
    for (const key of keys) {
      const e = cur[key];
      await invoke<string>("content_save_texture", { path, texture: key, png: e.url.slice(e.url.indexOf(",") + 1) });
      written[key] = e;
    }
    // The .mcmeta after its png: its frame size is checked against the image.
    for (const key of animKeys) await invoke<string>("content_save_texture_animation", { path, texture: key, animation: anims[key]?.animation ?? null });
    setSaved((s) => ({ ...s, ...Object.fromEntries(Object.entries(written).map(([k, e]) => [k, e.img])) }));
    setImages((m) => {
      const next = { ...m };
      for (const [k, e] of Object.entries(written)) next[k] = { url: e.url, animation: m[k]?.animation ?? null, writable: true };
      for (const k of animKeys) if (next[k]) next[k] = { ...next[k]!, animation: anims[k]?.animation ?? null };
      return next;
    });
  }, [path]);
  const sideDirty = !readOnly && (dirtyKeys.length > 0 || animDirtyKeys.length > 0);
  useEffect(() => setSideState(path, { dirty: sideDirty, save: saveTextures }), [path, sideDirty, saveTextures, setSideState]);
  useEffect(() => () => setSideState(path, null), [path, setSideState]);

  // A texture changed on disk (another editor, git) shows up when the window
  // regains focus — unless it has unsaved paint here.
  useEffect(() => {
    const recheck = () => {
      const { dirtyKeys: keys, images: cur } = saveState.current;
      for (const key of Object.keys(cur)) {
        if (keys.includes(key) || saveState.current.animDirtyKeys.includes(key)) continue;
        invoke<LoadedTexture>("content_texture", { path, texture: key })
          .then((src) => {
            if (saveState.current.images[key]?.url === src.url) return;
            setImages((m) => ({ ...m, [key]: src }));
            setAnimations({ [key]: null });
            setSaved((s) => {
              const { [key]: _, ...rest } = s;
              return rest;
            });
            if (editedRef.current[key]) setEditedImages({ [key]: null });
          })
          .catch(() => {});
      }
    };
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [path, setEditedImages, setAnimations]);

  // ── What the view draws ───────────────────────────────────────────────────

  const rotations = file.states?.rotations ?? [];
  const turnsWithState = effectiveKey === "model" || stateModelOf(effectiveKey) !== null;
  const rot = shownVariant && turnsWithState ? shownVariant : effectiveKey === "model" ? rotations[variant] : undefined;
  const parts = useMemo<Part[]>(() => {
    const own: Part = {
      elements: resolved.elements,
      textures: resolved.textures,
      sprite: resolved.sprite,
      tints,
      editable: true,
      x: rot?.x,
      y: rot?.y,
    };
    if (effectiveKey !== "arm") return [own];
    return [{ elements: mainResolved.elements, textures: mainResolved.textures, sprite: mainResolved.sprite, ghost: true }, own];
  }, [resolved, mainResolved, effectiveKey, rot, tints]);

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

  // ── Painting ──────────────────────────────────────────────────────────────

  const paintOn = !readOnly && (paintMode || !!resolved.sprite);
  const faceSlot = selEl && face ? selEl.faces[face]?.texture.replace(/^#/, "") : undefined;
  const paintSlots = resolved.slots.filter((s) => resolved.textures[s] && s !== "particle");
  const activeSlot = paintSlot && paintSlots.includes(paintSlot) ? paintSlot : faceSlot && paintSlots.includes(faceSlot) ? faceSlot : (paintSlots[0] ?? null);
  const activeKey = activeSlot ? resolved.textures[activeSlot] : undefined;
  const activeAnim = animOf(activeKey);
  const activeEntry = activeKey && activeAnim ? Math.max(0, Math.min(paintEntry[activeKey] ?? 0, activeAnim.frames.length - 1)) : 0;
  /** The image frame painted: the picked step's (frame 0 — the whole image — when it isn't animated). */
  const activeFrame = activeAnim?.frames[activeEntry]?.index ?? 0;

  /** What the view and the pickers show: painted textures over the loaded ones, the painted frame held while painting. */
  const shownImages = useMemo(() => {
    const out: Record<string, LoadedTexture | undefined> = {};
    for (const k of new Set([...Object.keys(images), ...Object.keys(edited)])) {
      const loaded = images[k];
      const e = edited[k];
      if (!loaded && !e) {
        out[k] = undefined;
        continue;
      }
      const animation = animEdits[k] ? animEdits[k]!.animation : (loaded?.animation ?? null);
      const pinned = paintOn && !playing && k === activeKey && animation ? activeFrame : undefined;
      out[k] = { url: e?.url ?? loaded!.url, animation, writable: e ? true : loaded!.writable, pinned };
    }
    return out;
  }, [images, edited, animEdits, paintOn, playing, activeKey, activeFrame]);
  // The 2D view follows the face picked in the outliner or the view.
  useEffect(() => {
    if (faceSlot) setPaintSlot(faceSlot);
  }, [faceSlot]);

  /** A new png under `resources/` for `slot` — `item/<file>.png`, `block/<file>_<slot>.png` and the like, not yet taken. */
  const newTexturePath = (slot: string): string => {
    const stem = (stemOf(path) || "texture").toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
    const folder = modelKind === "item" || resolved.sprite ? "item" : "block";
    const state = stateModelOf(effectiveKey);
    const several = paintSlots.length > 1 || effectiveKey === "arm" || state !== null;
    const base = `${folder}/${stem}${state !== null ? `_${state}` : ""}${several ? `_${slot}` : ""}`;
    const taken = new Set([...choices.textures, ...Object.keys(editedRef.current), ...named]);
    let value = `${base}.png`;
    for (let n = 2; taken.has(value); n++) value = `${base}_${n}.png`;
    return value;
  };

  /** Points `slot` at a new texture `img` (a copy, or a blank one) — one undo step, the file and the texture. */
  const assignTexture = (slot: string, img: PixelImage): string => {
    const key = newTexturePath(slot);
    documentAction(path, () => {
      const draft = clone(file);
      const m = ensureModel(draft, effectiveKey);
      m.textures = { ...(m.textures ?? {}), [slot]: key };
      onChange(patchContent(contentRef.current, draft));
      setEditedImages({ [key]: img });
      pixelStep(key, null, img);
    });
    return key;
  };

  /**
   * A stroke being painted: on one frame of an animated texture (`anim`,
   * image frame `frameIndex` of `strip`), else on the whole image.
   */
  const stroke = useRef<{ stroke: Stroke; slot: string; key: string; frame: number; anim: TextureAnimation | null; frameIndex: number; strip: PixelImage } | null>(null);
  /** The texture image with the stroke's pixels in it. */
  const strokeImage = (cur: NonNullable<typeof stroke.current>): PixelImage =>
    cur.anim ? pasteFrame(cur.strip, cur.anim, cur.frameIndex, cur.stroke.image) : cur.stroke.image;

  const beginPaint = (slot: string, x: number, y: number, pick: boolean) => {
    if (!paintOn || stroke.current) return;
    let key = resolved.textures[slot];
    let base = pixelsOf(key);
    if (!key || !base) return;
    // An animated texture is painted a frame at a time: the one picked in
    // the frame strip (for the texture in the 2D view), else the first.
    const anim = animOf(key);
    const frameIndex = anim ? (key === activeKey ? activeFrame : (anim.frames[0]?.index ?? 0)) : 0;
    const frameOf = (img: PixelImage) => (anim ? cropFrame(img, anim, frameIndex) : img);
    if (paint.tool === "picker" || pick) {
      const c = getPixel(frameOf(base), x, y);
      if (c) setPaint({ color: c, ...(paint.tool === "picker" ? { tool: "pencil" as const } : {}) });
      return;
    }
    if (paint.tool === "fill" && !getPixel(frameOf(base), x, y)) return;
    const writable = images[key]?.writable ?? key in editedRef.current;
    if (!writable) {
      // Not the mod's texture (Minecraft's, another mod's): paint a copy in the mod.
      base = cloneImage(base);
      key = assignTexture(slot, base);
      // The copy keeps the animation (written with it on Save).
      if (anim) setAnimations({ [key]: { animation: anim } });
      notify({ level: "info", message: t("Copied into the mod: {path}", { path: `resources/${key}` }) });
    }
    const s = new Stroke(frameOf(base), paint, x, y);
    stroke.current = { stroke: s, slot, key, frame: 0, anim, frameIndex, strip: base };
    setEditedImages({ [key]: strokeImage(stroke.current) });
  };

  const movePaint = (x: number, y: number) => {
    const cur = stroke.current;
    if (!cur) return;
    cur.stroke.move(x, y);
    // At most one redraw a frame.
    if (!cur.frame)
      cur.frame = requestAnimationFrame(() => {
        cur.frame = 0;
        if (stroke.current === cur) setEditedImages({ [cur.key]: strokeImage(cur) });
      });
  };

  const endPaint = () => {
    const cur = stroke.current;
    if (!cur) return;
    stroke.current = null;
    cancelAnimationFrame(cur.frame);
    const painted = strokeImage(cur);
    setEditedImages({ [cur.key]: painted });
    if (!sameImage(cur.stroke.image, cur.stroke.base)) {
      pixelStep(cur.key, cur.strip, painted);
      if (cur.stroke.settings.tool !== "eraser") usedColor(cur.stroke.settings.color);
    }
  };

  /** Changes texture `key`'s animation (and its image, when frames were added) — one undo step. */
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

  // ── Sprite layers ─────────────────────────────────────────────────────────

  const layers = useMemo(
    () => resolved.slots.filter((s) => LAYER.test(s)).sort((a, b) => layerIndex(a) - layerIndex(b)),
    [resolved.slots]
  );

  /** Rewrites the layers as `values` (`layer0`, `layer1`, … in order). */
  const setLayers = (values: string[]) =>
    update((d) => {
      const m = ensureModel(d, effectiveKey);
      const tex = Object.fromEntries(Object.entries(m.textures ?? {}).filter(([k]) => !LAYER.test(k)));
      values.forEach((v, i) => (tex[`layer${i}`] = v));
      m.textures = tex;
    });
  const layerValues = () => layers.map((s) => model?.textures?.[s] ?? resolved.textures[s] ?? "");

  const addLayer = () => {
    const first = pixelsOf(resolved.textures.layer0);
    const slot = `layer${layers.length}`;
    assignTexture(slot, blankImage(first?.w ?? 16, first?.h ?? 16));
    setPaintSlot(slot);
  };
  const removeLayer = (slot: string) => {
    setLayers(layerValues().filter((_, i) => layers[i] !== slot));
    setPaintSlot("layer0");
  };
  const moveLayer = (slot: string, by: -1 | 1) => {
    const i = layers.indexOf(slot);
    const values = layerValues();
    if (i + by < 0 || i + by >= values.length) return;
    [values[i], values[i + by]] = [values[i + by], values[i]];
    setLayers(values);
    setPaintSlot(`layer${i + by}`);
  };

  /** The sprite as elements of the model's own (one per rectangle of opaque pixels). */
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

  // ── Element commands ──────────────────────────────────────────────────────

  const firstSlot = resolved.slots[0];
  const addElement = () => {
    const slot = firstSlot ?? "0";
    editElements((els, m) => {
      if (!firstSlot) m.textures = { ...(m.textures ?? {}), [slot]: "minecraft:block/stone" };
      els.push({
        name: `cube${els.length + 1}`,
        from: [4, 0, 4],
        to: [12, 8, 12],
        faces: Object.fromEntries(DIRS.map((d) => [d, { texture: `#${slot}` }])),
      });
      setSelected(els.length - 1);
      setFace(null);
    });
  };
  const duplicateElement = () => {
    if (sel === null) return;
    editElements((els) => {
      els.splice(sel + 1, 0, { ...clone(els[sel]), name: els[sel].name ? `${els[sel].name}_copy` : undefined });
      setSelected(sel + 1);
    });
  };
  const deleteElement = () => {
    if (sel === null) return;
    editElements((els) => {
      els.splice(sel, 1);
      setSelected(els.length ? Math.min(sel, els.length - 1) : null);
      setFace(null);
    });
  };
  const moveElement = (by: -1 | 1) => {
    if (sel === null || sel + by < 0 || sel + by >= elements.length) return;
    editElements((els) => {
      const [el] = els.splice(sel, 1);
      els.splice(sel + by, 0, el);
      setSelected(sel + by);
    });
  };

  const addSlot = async () => {
    const slot = await promptDialog({
      title: t("Add Texture Slot"),
      label: t("Slot"),
      confirmLabel: t("Add"),
      validate: (v) => (/^[a-z0-9_]+$/.test(v) ? (resolved.slots.includes(v) ? t("This slot already exists.") : null) : t("Lowercase letters, digits and _.")),
    });
    if (slot) update((d) => void (ensureModel(d, effectiveKey).textures = { ...(ensureModel(d, effectiveKey).textures ?? {}), [slot]: "minecraft:block/stone" }));
  };

  // ── Block states ──────────────────────────────────────────────────────────

  /** Edits `states` (made if missing; emptied parts and an empty `states` removed). */
  const editStates = (edit: (st: States, d: ContentFile) => void) =>
    update((d) => {
      d.states ??= {};
      edit(d.states, d);
      for (const k of ["properties", "models", "variants"] as const) if (d.states[k] && !Object.keys(d.states[k]!).length) delete d.states[k];
      if (d.block && !Object.values(d.block).some((x) => x !== undefined)) delete d.block;
      if (!Object.values(d.states).some((x) => x !== undefined)) delete d.states;
    });

  /** Shows state `st` (`null`: the model as it is) and edits the model it shows. */
  const showState = (st: BlockState | null) => {
    setPreviewState(st);
    if (!st) return;
    const key = variantModelKey(variantOf(states, { ...defaultState(stateProps), ...st }).models);
    if (key !== effectiveKey) {
      setModelKey(key);
      setSelected(null);
      setFace(null);
    }
  };

  const pickState = (picked: StateSel) => {
    setStateSel(picked);
    setSelected(null);
    setFace(null);
    if (picked.kind === "model") {
      setModelKey(stateModelKey(picked.key));
      if (shownVariant && variantModelKey(shownVariant.models) !== stateModelKey(picked.key)) setPreviewState(null);
    } else if (picked.kind === "variant") {
      // The state it's for: its conditions over the default state.
      showState(Object.fromEntries(parseVariantKey(picked.key)));
    }
  };

  const stateModelNames = Object.keys(states?.models ?? {});

  const addStateProperty = async () => {
    const name = await promptDialog({
      title: t("Add State Property"),
      message: t("A property of the block's states, yes/no to start with — make it a number range or a list of values in Properties."),
      label: t("Name"),
      defaultValue: freeName("powered", stateProps.map((p) => p.name)),
      confirmLabel: t("Add"),
      validate: (v) => {
        const problem = propertyNameProblem(v, stateProps.map((p) => p.name));
        return problem && t(problem);
      },
    });
    if (!name) return;
    editStates((st) => void (st.properties = { ...(st.properties ?? {}), [name]: [...YES_NO] }));
    pickState({ kind: "property", key: name });
  };

  /** A new state model, a copy of the block's model; edited in the view next. */
  const addStateModel = async () => {
    const name = await promptDialog({
      title: t("Add State Model"),
      message: t("Another model of the block, for the states its variants pick. It starts as a copy of the block's model."),
      label: t("Name"),
      defaultValue: freeName("variant", stateModelNames),
      confirmLabel: t("Add"),
      validate: (v) => (!isWord(v) ? t("Lowercase letters, digits and _.") : stateModelNames.includes(v) ? t("The block already has a model of this name.") : null),
    });
    if (!name) return;
    editStates((st) => void (st.models = { ...(st.models ?? {}), [name]: stateModelFrom(file.model) }));
    pickState({ kind: "model", key: name });
  };

  /** A new variant for the first condition none has yet; a state model made for it if there's none. */
  const addVariant = () => {
    const key = newVariantKey(states ?? {});
    if (key === null) {
      notify({ level: "info", message: t("Every property's value already has a variant — edit their conditions in Properties.") });
      return;
    }
    const current = stateModelOf(effectiveKey);
    const name = current ?? stateModelNames[0] ?? "variant";
    editStates((st) => {
      if (!st.models?.[name]) st.models = { ...(st.models ?? {}), [name]: stateModelFrom(file.model) };
      st.variants = { ...(st.variants ?? {}), [key]: name };
    });
    setStateSel({ kind: "variant", key });
    setPreviewState(Object.fromEntries(parseVariantKey(key)));
    setModelKey(stateModelKey(name));
    setSelected(null);
    setFace(null);
  };

  const removeStateItem = (picked: StateSel) => {
    editStates((st, d) => {
      if (picked.kind === "property") removeProperty(st, d.block, picked.key);
      else if (picked.kind === "model") removeModel(st, picked.key);
      else if (st.variants) delete st.variants[picked.key];
    });
    if (picked.kind === "model" && effectiveKey === stateModelKey(picked.key)) setModelKey("model");
    setStateSel(null);
  };

  const moveStateVariant = (key: string, by: -1 | 1) => editStates((st) => moveVariant(st, key, by));

  const viewCode = () => {
    const tab = tabs.find((x) => x.path === path);
    if (tab) void setView(tab.id, CONTENT_SOURCE_VIEW);
  };

  // ── Keyboard and Edit menu ────────────────────────────────────────────────

  const inField = () => {
    const el = document.activeElement;
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
  };
  const focusedWithin = () => !!rootRef.current && rootRef.current.contains(document.activeElement);
  const editable = () => !readOnly && focusedWithin() && !inField();
  /** Copies the selected element as JSON (pasteable into another model, or Blockbench-style text). */
  const copyElement = async () => {
    if (!selEl) return false;
    await navigator.clipboard.writeText(serializeContent(selEl as unknown as ContentFile));
    return true;
  };
  const pasteElement = async () => {
    let value: unknown;
    try {
      value = JSON.parse(await navigator.clipboard.readText());
    } catch {
      return;
    }
    const list = (Array.isArray(value) ? value : [value]).filter(
      (v): v is Element => !!v && typeof v === "object" && Array.isArray((v as Element).from) && Array.isArray((v as Element).to) && typeof (v as Element).faces === "object"
    );
    if (!list.length) return;
    editElements((els) => {
      const at = sel === null ? els.length : sel + 1;
      els.splice(at, 0, ...list);
      setSelected(at);
      setFace(null);
    });
  };
  /** Deletes the picked element, else the picked property, state model or variant. */
  const deleteSelected = () => (sel === null && pickedState ? removeStateItem(pickedState) : deleteElement());
  const commands = useRef({ deleteElement, deleteSelected, duplicateElement, copyElement, pasteElement, sel, elements });
  commands.current = { deleteElement, deleteSelected, duplicateElement, copyElement, pasteElement, sel, elements };
  useKeybinding("Delete", () => commands.current.deleteSelected(), { when: editable });
  useKeybinding("Ctrl+C", () => void commands.current.copyElement(), { when: editable });
  useKeybinding("Ctrl+X", () => void commands.current.copyElement().then((ok) => ok && commands.current.deleteElement()), { when: editable });
  useKeybinding("Ctrl+V", () => void commands.current.pasteElement(), { when: editable });
  useKeybinding("Ctrl+D", () => commands.current.duplicateElement(), { when: editable });
  const pickGizmo = (g: GizmoMode) => {
    setGizmo(g);
    setPaintMode(false);
  };
  useKeybinding("G", () => pickGizmo("move"), { when: editable });
  useKeybinding("S", () => pickGizmo("resize"), { when: editable });
  useKeybinding("P", () => setPaintMode(true), { when: editable });
  const painting = () => editable() && (paintMode || !!resolved.sprite);
  const paintRef = useRef(paint);
  paintRef.current = paint;
  useKeybinding("B", () => setPaint({ tool: "pencil" }), { when: painting });
  useKeybinding("E", () => setPaint({ tool: "eraser" }), { when: painting });
  useKeybinding("F", () => setPaint({ tool: "fill" }), { when: painting });
  useKeybinding("I", () => setPaint({ tool: "picker" }), { when: painting });
  useKeybinding("L", () => setPaint({ tool: "line" }), { when: painting });
  useKeybinding("R", () => setPaint({ tool: "rect" }), { when: painting });
  useKeybinding("M", () => setPaint({ mirrorX: !paintRef.current.mirrorX }), { when: painting });
  useKeybinding("[", () => setPaint({ size: Math.max(1, paintRef.current.size - 1) }), { when: painting });
  useKeybinding("]", () => setPaint({ size: Math.min(4, paintRef.current.size + 1) }), { when: painting });
  useKeybinding("F7", viewCode, { when: focusedWithin });

  useEffect(
    () =>
      registerDocumentCommands(path, {
        hasSelection: () => commands.current.sel !== null,
        cut: () => void commands.current.copyElement().then((ok) => ok && commands.current.deleteElement()),
        copy: () => void commands.current.copyElement(),
        canPaste: () => !readOnly,
        paste: () => void commands.current.pasteElement(),
        selectAll: () => {},
        delete: () => commands.current.deleteElement(),
      }),
    [path, readOnly]
  );
  useEffect(() => notifyDocumentCommands(), [sel]);

  // ── Properties ────────────────────────────────────────────────────────────

  const properties = useMemo<PropertyDescriptor[]>(() => {
    const out: PropertyDescriptor[] = [];
    const ro = readOnly;
    /** Optional number as text: empty = unset. */
    const num = (
      id: string,
      name: string,
      category: string,
      value: number | undefined,
      set: (v: number | undefined) => void,
      opts: { min?: number; max?: number; int?: boolean; description?: string } = {}
    ): PropertyDescriptor => ({
      id,
      name,
      category,
      description: opts.description,
      value: value ?? "",
      kind: "string",
      readOnly: ro,
      validate: (v) => {
        const s = String(v).trim();
        if (s === "") return null;
        const n = Number(s);
        if (Number.isNaN(n)) return t("Not a valid number.");
        if (opts.int && !Number.isInteger(n)) return t("A whole number.");
        if ((opts.min !== undefined && n < opts.min) || (opts.max !== undefined && n > opts.max))
          return t("Between {min} and {max}.", { min: opts.min ?? "-∞", max: opts.max ?? "∞" });
        return null;
      },
      onCommit: (v) => set(String(v).trim() === "" ? undefined : Number(v)),
    });
    const text = (id: string, name: string, category: string, value: string | undefined, set: (v: string | undefined) => void, extra: Partial<PropertyDescriptor> = {}): PropertyDescriptor => ({
      id,
      name,
      category,
      value: value ?? "",
      kind: "string",
      readOnly: ro,
      onCommit: (v) => set(String(v).trim() === "" ? undefined : String(v).trim()),
      ...extra,
    });
    const choice = (id: string, name: string, category: string, value: string | undefined, options: readonly string[], set: (v: string | undefined) => void, extra: Partial<PropertyDescriptor> = {}): PropertyDescriptor => ({
      id,
      name,
      category,
      value: value ?? "",
      kind: "enum",
      options: ["", ...options],
      readOnly: ro,
      onCommit: (v) => set(String(v) === "" ? undefined : String(v)),
      ...extra,
    });
    const flag = (id: string, name: string, category: string, value: boolean | undefined, set: (v: boolean | undefined) => void, def: boolean, extra: Partial<PropertyDescriptor> = {}): PropertyDescriptor => ({
      id,
      name,
      category,
      value: value ?? def,
      kind: "bool",
      readOnly: ro,
      onCommit: (v) => set(v === def ? undefined : Boolean(v)),
      ...extra,
    });
    const vec = (id: string, name: string, category: string, value: readonly number[] | undefined, n: number, set: (v: number[] | undefined) => void, min?: number, max?: number, optional = true): PropertyDescriptor => ({
      id,
      name,
      category,
      value: vecText(value),
      kind: "string",
      readOnly: ro,
      validate: (v) => {
        if (optional && String(v).trim() === "") return null;
        const r = parseVec(String(v), n, min, max);
        if (r === "count") return t("{n} numbers, comma-separated.", { n });
        if (r === "range") return t("Between {min} and {max}.", { min: min ?? "-∞", max: max ?? "∞" });
        return null;
      },
      onCommit: (v) => {
        if (String(v).trim() === "") return set(undefined);
        const r = parseVec(String(v), n, min, max);
        if (typeof r !== "string") set(r);
      },
    });
    /** A list as comma-separated text: empty = unset. */
    const list = (id: string, name: string, category: string, value: readonly string[] | undefined, set: (v: string[] | undefined) => void, extra: Partial<PropertyDescriptor> = {}): PropertyDescriptor =>
      text(id, name, category, value?.join(", "), (v) => {
        const items = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        set(items.length ? items : undefined);
      }, extra);
    const prune = (o: Record<string, unknown> | undefined) => !!o && Object.values(o).every((x) => x === undefined);
    const yesNoProperties = Object.entries(file.states?.properties ?? {})
      .filter(([, values]) => values.length === 2 && values.includes("true") && values.includes("false"))
      .map(([name]) => name);

    // General.
    const general = t("General");
    out.push(
      text("id", t("Id"), general, file.id, (v) => update((d) => void (d.id = v)), {
        description: t("The registry id — `namespace:name`, or just `name` (the mod's namespace). Default: the file name."),
      }),
      text("name", t("Name"), general, file.name, (v) => update((d) => void (d.name = v)), {
        suggestions: choices.strings,
        description: t("Display name — a literal English text or a `@Set.name` text of a .yres file (translated)."),
      }),
      text("tooltip", t("Tooltip"), general, file.tooltip, (v) => update((d) => void (d.tooltip = v)), {
        suggestions: choices.strings,
        description: t("A line under the name — literal or `@Set.name`."),
      }),
      choice("register", t("Registration"), general, file.register, ["auto", "manual"], (v) => update((d) => void (d.register = v as ContentFile["register"])), {
        description: t("auto: registered by yog_api::content!(); manual: you register Blocks::x() / Items::x() yourself (to add behavior)."),
      }),
      list("tags", t("Tags"), general, file.tags, (v) => update((d) => void (d.tags = v)), {
        suggestions: choices.tags,
        description:
          kind === "block"
            ? t("Tags it's in, comma-separated: Yog's common tags (yog:logs — the game's or each loader's tag of that meaning), the game's (minecraft:logs) or the mod's own by name. A block joins the block tag and its item the item tag.")
            : t("Tags it's in, comma-separated: Yog's common tags (yog:ingots/iron — the game's or each loader's tag of that meaning), the game's (minecraft:planks) or the mod's own by name."),
      }),
      list("requires", t("Requires Mods"), general, file.requires, (v) => update((d) => void (d.requires = v)), {
        description: t("Mods it needs, comma-separated — Yog or Java mod ids (pehkui): without every one of them loaded it isn't there."),
      })
    );

    // Block / item properties.
    if (kind === "block") {
      const c = t("Block");
      const b = file.block ?? {};
      const blockKind = blockKinds.find((candidate) => candidate.name === file.kind);
      const setB = (edit: (b: NonNullable<ContentFile["block"]>) => void) =>
        update((d) => {
          d.block ??= {};
          edit(d.block);
          if (prune(d.block as Record<string, unknown>)) delete d.block;
        });
      const drops = typeof b.drops === "object" ? (b.drops.item ?? "").replace(/^@item:/, "") : (b.drops ?? "");
      const tools = Array.isArray(b.tool) ? b.tool.join(", ") : b.tool;
      out.push(
        choice("block_kind", t("Block Kind"), c, file.kind, [...new Set([...blockKinds.map((candidate) => candidate.name), ...(file.kind ? [file.kind] : [])])], (v) =>
          update((d) => {
            if (v) d.kind = v;
            else delete d.kind;
            const takes = blockKinds.find((candidate) => candidate.name === v)?.takes ?? [];
            if (d.block) {
              for (const field of ["base", "set", "press_ticks", "triggered_by"] as const) {
                if (!takes.includes(field)) delete d.block[field];
              }
              if (prune(d.block as Record<string, unknown>)) delete d.block;
            }
          }), {
          optionLabel: (name) => t(name),
          description: t("Use a built-in block class (stairs, slabs, doors, buttons and related blocks); its states, models and item form come from the game."),
        }),
        num("hardness", t("Hardness"), c, b.hardness, (v) => setB((x) => void (x.hardness = v)), { min: -1, description: t("Mining time factor (stone 1.5, -1 unbreakable).") }),
        num("resistance", t("Blast Resistance"), c, b.resistance, (v) => setB((x) => void (x.resistance = v)), { min: 0 }),
        text("sound", t("Sound"), c, b.sound, (v) => setB((x) => void (x.sound = v || undefined)), {
          suggestions: choices.sounds,
          description: t("One of the game's sound groups (stone, wood, metal, amethyst…) — or the mod's own, @sound_group:mymod:crystal (a .ydef)."),
        }),
        num("light", t("Light Level"), c, b.light, (v) => setB((x) => void (x.light = v)), { min: 0, max: 15, int: true }),
        text(
          "tool",
          pt("block", "Tool"),
          c,
          tools,
          (v) =>
            setB((x) => {
              const list = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
              x.tool = list.length === 0 ? undefined : list.length === 1 ? list[0] : list;
            }),
          { suggestions: TOOLS, description: t("pickaxe, axe, shovel, hoe — or a mod's tool tag, @tag:block:mymod:mineable/hammer; several separated by commas.") }
        ),
        text("tool_level", t("Tool Level"), c, b.tool_level, (v) => setB((x) => void (x.tool_level = v || undefined)), {
          suggestions: TOOL_LEVELS,
          description: t("wood, stone, iron, diamond, netherite — or a level of the tool ladder, @level:mymod:mythril (a .ydef)."),
        }),
        flag("requires_tool", t("Requires Tool"), c, b.requires_tool, (v) => setB((x) => void (x.requires_tool = v)), false, { description: t("Drops nothing unless mined with the right tool.") }),
        flag("collision", t("Collision"), c, b.collision, (v) => setB((x) => void (x.collision = v)), true),
        num("slipperiness", t("Slipperiness"), c, b.slipperiness, (v) => setB((x) => void (x.slipperiness = v)), { min: 0, max: 1, description: t("0.6 normal, 0.98 ice.") }),
        choice("render_layer", t("Render Layer"), c, b.render_layer, RENDER_LAYERS, (v) => setB((x) => void (x.render_layer = v)), {
          description: t("cutout for textures with fully transparent pixels, translucent for glass-like ones."),
        }),
        text(
          "shape",
          t("Shape"),
          c,
          Array.isArray(b.shape) ? vecText(b.shape) : b.shape,
          (v) =>
            setB((x) => {
              if (v === undefined || v === "auto" || v === "full") x.shape = v as "auto" | "full" | undefined;
              else {
                const r = parseVec(v, 6, 0, 16);
                if (typeof r !== "string") x.shape = r;
              }
            }),
          {
            suggestions: ["auto", "full"],
            validate: (v) => {
              const s = String(v).trim();
              if (s === "" || s === "auto" || s === "full") return null;
              const r = parseVec(s, 6, 0, 16);
              return typeof r === "string" ? t("auto, full or x1, y1, z1, x2, y2, z2") : null;
            },
            description: t("The outline/collision box: auto (the model's bounds), full, or x1, y1, z1, x2, y2, z2 in pixels."),
          }
        ),
        text(
          "drops",
          t("Drops"),
          c,
          drops,
          (v) =>
            setB((x) => {
              if (v === undefined || v === "self" || v === "none") x.drops = v as "self" | "none" | undefined;
              else x.drops = { ...(typeof x.drops === "object" ? x.drops : {}), item: v.startsWith("@") ? v : `@item:${v}` };
            }),
          { suggestions: ["self", "none"], description: t("self (default), none, or an item id.") }
        ),
        text(
          "connect_groups",
          t("Connects With"),
          c,
          b.connect_groups?.join(", "),
          (v) => setB((x) => void (x.connect_groups = v ? v.split(/[,\s]+/).filter(Boolean) : undefined)),
          { description: t("Groups of blocks this one connects to (with an arm model in States). Default: itself.") }
        ),
        text("inventory", t("Inventory"), c, b.inventory, (v) => setB((x) => void (x.inventory = v)), {
          description: t("The inventory screen it opens: the id of a .yui <Screen> with <Slot>s."),
        }),
        flag("accepts_items", t("Accepts Items"), c, b.accepts_items, (v) => setB((x) => void (x.accepts_items = v)), false, {
          description: t("Hoppers and droppers can put items into it; the mod takes what it wants (on_item_insert)."),
        }),
        flag("redstone", t("Redstone Source"), c, b.redstone, (v) => setB((x) => void (x.redstone = v)), false, {
          description: t("Gives off redstone power, set by the mod per position."),
        }),
        text("powered", t("Powered Property"), c, b.powered, (v) => setB((x) => void (x.powered = v)), {
          suggestions: yesNoProperties,
          description: t("A yes/no property of its states kept on while it gets redstone power."),
        }),
        text("comparator", t("Comparator Property"), c, b.comparator, (v) => setB((x) => void (x.comparator = v)), {
          suggestions: yesNoProperties,
          description: t("A yes/no property of its states a comparator reads: 15 while it's on."),
        }),
        flag("occludes", t("Occludes"), c, b.occludes, (v) => setB((x) => void (x.occludes = v)), blockKind?.occludes ?? true, {
          description: t("Hides block faces behind it and blocks light. The selected block kind supplies the default."),
        }),
        ...(blockKind?.takes.includes("base")
          ? [text("kind_base", t("Kind Base Block"), c, b.base, (v) => setB((x) => void (x.base = v)), {
              suggestions: refSuggestions(blockRefs, "block"),
              validate: (v) => refMessage(t, refProblem(String(v), "block", blockRefs), "block"),
              description: t("The block this kind is based on, as @block:namespace:id (for example, a stair or slab's material block)."),
            })]
          : []),
        ...(blockKind?.takes.includes("set")
          ? [text("kind_set", t("Kind Set"), c, b.set, (v) => setB((x) => void (x.set = v)), {
              description: t("The registered block set, such as oak, dark_oak, iron or stone. The game's set names are open-ended."),
            })]
          : []),
        ...(blockKind?.takes.includes("press_ticks")
          ? [num("press_ticks", t("Press Ticks"), c, b.press_ticks, (v) => setB((x) => void (x.press_ticks = v)), {
              min: 1,
              int: true,
              description: t("How long a pressed button stays active, in ticks (30 by default)."),
            })]
          : []),
        ...(blockKind?.takes.includes("triggered_by")
          ? [choice("triggered_by", t("Triggered By"), c, b.triggered_by ?? "everything", ["everything", "mobs"], (v) =>
              setB((x) => void (x.triggered_by = v === "everything" ? undefined : v as NonNullable<ContentFile["block"]>["triggered_by"])), {
              optionLabel: (value) => t(value === "mobs" ? "Mobs Only" : "Everything"),
              description: t("What can trigger a button or pressure plate: everything includes items and arrows; mobs means living entities only."),
            })]
          : [])
      );
      // Its item form: how it stacks, survives fire, burns.
      const ic = t("Item");
      const bi = file.item ?? {};
      const setBI = (edit: (i: NonNullable<ContentFile["item"]>) => void) =>
        update((d) => {
          d.item ??= {};
          edit(d.item);
          if (prune(d.item as Record<string, unknown>)) delete d.item;
        });
      out.push(
        num("item_stack_size", t("Stack Size"), ic, bi.stack_size, (v) => setBI((x) => void (x.stack_size = v)), { min: 1, max: 99, int: true, description: t("How many of its item stack (64 by default).") }),
        flag("item_fire_resistant", t("Fire Resistant"), ic, bi.fire_resistant, (v) => setBI((x) => void (x.fire_resistant = v)), false),
        num("item_fuel_ticks", t("Fuel Ticks"), ic, bi.fuel_ticks, (v) => setBI((x) => void (x.fuel_ticks = v)), { min: 1, int: true, description: t("Burn time in a furnace (coal: 1600).") })
      );
    } else {
      const c = t("Item");
      const it = file.item ?? {};
      const setI = (edit: (i: NonNullable<ContentFile["item"]>) => void) =>
        update((d) => {
          d.item ??= {};
          edit(d.item);
          if (prune(d.item as Record<string, unknown>)) delete d.item;
        });
      out.push(
        num("stack_size", t("Stack Size"), c, it.stack_size, (v) => setI((x) => void (x.stack_size = v)), { min: 1, max: 99, int: true }),
        num("durability", t("Durability"), c, it.durability, (v) => setI((x) => void (x.durability = v)), { min: 1, int: true }),
        flag("fire_resistant", t("Fire Resistant"), c, it.fire_resistant, (v) => setI((x) => void (x.fire_resistant = v)), false),
        num("fuel_ticks", t("Fuel Ticks"), c, it.fuel_ticks, (v) => setI((x) => void (x.fuel_ticks = v)), { min: 1, int: true, description: t("Burn time in a furnace (coal: 1600).") }),
        num("nutrition", t("Food: Nutrition"), c, it.food?.nutrition, (v) =>
          setI((x) => {
            if (v === undefined) delete x.food;
            else x.food = { ...(x.food ?? {}), nutrition: v };
          }), { min: 0, int: true }),
        num("saturation", t("Food: Saturation"), c, it.food?.saturation, (v) => setI((x) => void (x.food && (x.food.saturation = v))), { min: 0 }),
        flag("always_edible", t("Food: Always Edible"), c, it.food?.always_edible, (v) => setI((x) => void (x.food && (x.food.always_edible = v))), false),
        text("tool_kind", t("Tool: Kind"), c, it.tool?.kind, (v) =>
          setI((x) => {
            if (v === undefined) delete x.tool;
            else x.tool = { material: "iron", ...(x.tool ?? {}), kind: v };
          }), {
          suggestions: TOOL_KINDS,
          description: t("pickaxe, axe, shovel, hoe, sword — or a mod's kind by the blocks it mines, @tag:block:mymod:mineable/hammer."),
        }),
        ...(it.tool
          ? [
              text("tool_material", t("Tool: Material"), c, it.tool.material, (v) => setI((x) => void (x.tool && v && (x.tool.material = v))), {
                suggestions: choices.toolMaterials,
                description: t("The game's material (wood, stone, iron, diamond, gold, netherite) or the mod's, @tool_material:mymod:mythril (a .ydef)."),
              }),
              num("attack_damage", t("Tool: Attack Damage"), c, it.tool.attack_damage, (v) => setI((x) => void (x.tool && (x.tool.attack_damage = v))), {
                description: t("On top of the material's. Default: the kind's (sword 3, axe 6, shovel 1.5, pickaxe 1, hoe 0)."),
              }),
              num("attack_speed", t("Tool: Attack Speed"), c, it.tool.attack_speed, (v) => setI((x) => void (x.tool && (x.tool.attack_speed = v))), {
                description: t("Change of attack speed. Default: the kind's (sword -2.4, axe -3.1, shovel -3, pickaxe -2.8, hoe -1)."),
              }),
            ]
          : []),
        choice("armor_slot", t("Armor: Slot"), c, it.armor?.slot, ARMOR_SLOTS, (v) =>
          setI((x) => {
            if (v === undefined) delete x.armor;
            else x.armor = { material: "iron", ...(x.armor ?? {}), slot: v as ArmorSlot };
          }), { optionLabel: (o) => (o ? t(o) : "") }),
        ...(it.armor
          ? [
              text("armor_material", t("Armor: Material"), c, it.armor.material, (v) => setI((x) => void (x.armor && v && (x.armor.material = v))), {
                suggestions: choices.armorMaterials,
                description: t("The game's material (leather, chainmail, iron, gold, diamond, turtle, netherite) or the mod's, @armor_material:mymod:mythril (a .ydef)."),
              }),
            ]
          : []),
        choice("wearable", t("Wearable"), c, it.wearable, ARMOR_SLOTS, (v) => setI((x) => void (x.wearable = v as ArmorSlot | undefined)), {
          optionLabel: (o) => (o ? t(o) : ""),
          description: t("Worn in this slot without being armor (a monocle, a crown): right-click and dispensers put it on."),
        }),
        {
          id: "potion",
          name: t("Potion"),
          category: c,
          value: !!it.potion,
          kind: "bool",
          readOnly: ro,
          description: t("This .yitem defines a potion registry entry, not an extra bottle item. Brewing recipes are .yrecipe files."),
          onCommit: (v) => setI((x) => {
            if (v) x.potion ??= { effects: [] };
            else delete x.potion;
          }),
        },
        ...(it.potion
          ? [
              text("potion_name", t("Potion Name"), c, it.potion.name, (v) => setI((x) => {
                if (!x.potion) return;
                if (v) x.potion.name = v;
                else delete x.potion.name;
              }), { description: t("The translation suffix for item.minecraft.potion.effect.<name>. Defaults to this .yitem id's path.") }),
              {
                id: "potion_effects",
                name: "",
                category: t("Potion Effects"),
                value: null,
                kind: "custom",
                description: t("The mob effects this potion gives, in ticks (20 per second) and levels (0 is I)."),
                render: () => (
                  <RowsEditor<PotionEffectRow>
                    rows={it.potion?.effects ?? []}
                    readOnly={ro}
                    blank={() => ({ effect: "@effect:minecraft:speed", duration: 3600, amplifier: 0 })}
                    onChange={(effects) => setI((x) => {
                      if (x.potion) {
                        x.potion.effects = effects.flatMap(({ effect, duration, amplifier }) =>
                          effect ? [{ effect, duration: duration ?? 3600, ...(amplifier === undefined ? {} : { amplifier }) }] : [],
                        );
                      }
                    })}
                    columns={[
                      { key: "effect", label: t("Effect"), kind: "text", grow: 3, suggestions: refSuggestions(effectRefs, "effect"), validate: (v) => refMessage(t, refProblem(v, "effect", effectRefs), "effect") },
                      { key: "duration", label: t("Ticks"), kind: "number", min: 1, int: true },
                      { key: "amplifier", label: t("Level"), kind: "number", min: 0, int: true, placeholder: "0" },
                    ]}
                  />
                ),
              } satisfies PropertyDescriptor,
            ]
          : []),
        text("hangs_entity", t("Hanging Entity"), c, it.hangs?.entity, (v) =>
          setI((x) => {
            if (!v) delete x.hangs;
            else x.hangs = { ...(x.hangs ?? {}), entity: v };
          }), {
          suggestions: refSuggestions(entityRefs, "entity"),
          validate: (v) => refMessage(t, refProblem(String(v), "entity", entityRefs), "entity"),
          description: t("A hanging entity this item places, as @entity:namespace:id; it must have kind: hanging."),
        }),
        ...(it.hangs
          ? [vec("hangs_size", t("Hanging Size"), c, it.hangs.size, 2, (v) =>
              setI((x) => {
                if (!x.hangs) return;
                if (v) x.hangs.size = [v[0], v[1]];
                else delete x.hangs.size;
              }), 1, 4_294_967_295, true)]
          : [])
      );
    }

    // States.
    if (kind === "block") {
      const c = t("States");
      out.push(
        text(
          "rotations",
          t("Random Rotations"),
          c,
          rotationsText(file.states?.rotations),
          (v) =>
            update((d) => {
              const r = v ? parseRotations(v) : [];
              if (typeof r === "string") return;
              d.states ??= {};
              d.states.rotations = r.length ? r : undefined;
              if (prune(d.states as Record<string, unknown>)) delete d.states;
            }),
          {
            suggestions: ["0,0; 0,90; 0,180; 0,270", "0,0; 90,0; 180,0; 270,0; 0,90; 0,270"],
            validate: (v) => {
              const r = String(v).trim() ? parseRotations(String(v)) : [];
              return typeof r === "string" ? t(r) : null;
            },
            description: t("Variants picked at random per position (x,y in degrees, *weight) — like stone's. The toolbar previews each."),
          }
        ),
        {
          id: "connects",
          name: t("Connects"),
          category: c,
          value: !!file.states?.connect,
          kind: "bool",
          readOnly: ro,
          description: t("Adds an arm model drawn towards each neighbor it connects to (fences, pipes)."),
          onCommit: (v) =>
            update((d) => {
              if (v) {
                d.states ??= {};
                d.states.connect ??= { arm: ARM_TEMPLATE(mainResolved.textures[mainResolved.slots[0]] ?? "minecraft:block/stone") };
              } else if (d.states) {
                delete d.states.connect;
                if (prune(d.states as Record<string, unknown>)) delete d.states;
                if (modelKey === "arm") setModelKey("model");
              }
            }),
        },
        ...(file.states?.connect
          ? [flag("arm_uvlock", t("Arm UV Lock"), c, file.states.connect.uvlock, (v) => update((d) => void (d.states!.connect!.uvlock = v)), false)]
          : [])
      );
    }

    // How it's placed.
    if (kind === "block") {
      const c = t("States");
      const st = file.states ?? {};
      const setS = (edit: (s: NonNullable<ContentFile["states"]>) => void) =>
        update((d) => {
          d.states ??= {};
          edit(d.states);
          if (prune(d.states as Record<string, unknown>)) delete d.states;
        });
      out.push(
        choice("facing", t("Facing"), c, st.facing, FACINGS, (v) => setS((x) => void (x.facing = v as typeof st.facing)), {
          optionLabel: (o) => (o ? t(FACING_LABELS[o as keyof typeof FACING_LABELS]) : ""),
          description: t("The block turns when placed (a facing property); its model's north side is its front."),
        }),
        choice("placement", t("Placement"), c, st.placement, PLACEMENTS, (v) => setS((x) => void (x.placement = v as typeof st.placement)), {
          optionLabel: (o) => (o ? t(o) : ""),
          description: t("toward: its front faces the player (a furnace, the default); away: the way they look (an observer)."),
        }),
        flag("attach", t("Attaches"), c, st.attach, (v) => setS((x) => void (x.attach = v)), false, {
          description: t("Hangs on a floor, wall or ceiling, as a button does; its model lies on the floor."),
        }),
        flag("waterlogged", t("Waterloggable"), c, st.waterlogged, (v) => setS((x) => void (x.waterlogged = v)), false, {
          description: t("It can stand in water."),
        }),
        flag("states_uvlock", t("UV Lock"), c, st.uvlock, (v) => setS((x) => void (x.uvlock = v)), false, {
          description: t("Its textures stay as they are in the world when it turns."),
        })
      );
    }

    // The property, state model or variant picked in the outliner.
    if (kind === "block" && pickedState && states) {
      const key = pickedState.key;
      if (pickedState.kind === "property") {
        const c = `${t("State Property")}: ${key}`;
        const values = states.properties![key];
        const pk = propertyKind(values);
        const setValues = (next: string[]) => editStates((st) => void (st.properties![key] = next));
        const nums = values.map(Number);
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        out.push(
          text("sp.name", t("Name"), c, key, (v) => {
            if (!v || v === key) return;
            editStates((st, d) => renameProperty(st, d.block, key, v));
            setStateSel({ kind: "property", key: v });
          }, {
            validate: (v) => {
              const name = String(v).trim();
              const problem = name === key ? null : propertyNameProblem(name, stateProps.map((p) => p.name));
              return problem && t(problem);
            },
            description: t("Renaming it renames it in the variants and in Powered/Comparator Property too."),
          }),
          {
            id: "sp.kind",
            name: t("Kind"),
            category: c,
            value: pk,
            kind: "enum",
            options: PROPERTY_KINDS,
            optionLabel: (o) => t(PROPERTY_KIND_LABELS[o as PropertyKind]),
            readOnly: ro,
            description: t("Yes/No: false, true. Number Range: whole numbers from one to another. Values: names of your own."),
            onCommit: (v) => {
              if (v === pk) return;
              if (v === "bool") setValues([...YES_NO]);
              else if (v === "range") setValues(rangeValues(0, Math.max(1, values.length - 1)));
              else setValues(pk === "bool" ? ["off", "on"] : values.map((x) => `n${x}`));
            },
          }
        );
        if (pk === "range") {
          out.push(
            num("sp.min", t("Minimum"), c, min, (v) => v !== undefined && v < max && setValues(rangeValues(v, max, values[0])), { min: 0, max: max - 1, int: true }),
            num("sp.max", t("Maximum"), c, max, (v) => v !== undefined && v > min && setValues(rangeValues(min, v, values[0])), { min: min + 1, int: true })
          );
        } else if (pk === "values") {
          out.push(
            text("sp.values", t("Values"), c, values.join(", "), (v) => {
              const next = (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
              if (!valuesProblem(next)) setValues(next);
            }, {
              validate: (v) => {
                const problem = valuesProblem(String(v).split(",").map((x) => x.trim()).filter(Boolean));
                return problem && t(problem);
              },
              description: t("Its values, comma-separated: lowercase letters, digits and _. The first is the default."),
            })
          );
        }
        out.push({
          id: "sp.default",
          name: t("Default"),
          category: c,
          value: values[0],
          kind: "enum",
          options: pk === "range" ? [...values].sort((a, b) => Number(a) - Number(b)) : values,
          readOnly: ro,
          description: pk === "bool" ? t("The value a placed block starts with. Powered and Comparator Property need false.") : t("The value a placed block starts with."),
          onCommit: (v) => setValues(withDefault(values, String(v))),
        });
      } else if (pickedState.kind === "model") {
        const c = `${t("State Model")}: ${key}`;
        const users = Object.entries(states.variants ?? {})
          .filter(([, v]) => modelNames(v).includes(key))
          .map(([k]) => k || t("Every state"));
        out.push(
          text("sm.name", t("Name"), c, key, (v) => {
            if (!v || v === key) return;
            editStates((st) => renameModel(st, key, v));
            setStateSel({ kind: "model", key: v });
            if (effectiveKey === stateModelKey(key)) setModelKey(stateModelKey(v));
          }, {
            validate: (v) => {
              const name = String(v).trim();
              if (name === key) return null;
              return !isWord(name) ? t("Lowercase letters, digits and _.") : stateModelNames.includes(name) ? t("The block already has a model of this name.") : null;
            },
            description: t("Renaming it renames it in the variants too."),
          }),
          {
            id: "sm.users",
            name: t("Used By"),
            category: c,
            value: users.join("; ") || t("No variant — add one that picks it."),
            kind: "string",
            readOnly: true,
          }
        );
      } else {
        const c = t("Variant");
        const when = Object.fromEntries(parseVariantKey(key));
        const problems = variantProblems(states, key);
        const setWhen = (name: string, value: string | undefined): string | void => {
          const next = variantKey({ ...when, [name]: value ?? "" }, stateProps);
          if (next === key) return;
          if (states.variants && next in states.variants) return t("Another variant has these conditions.");
          editStates((st) => void setVariantKey(st, key, next));
          setStateSel({ kind: "variant", key: next });
          setPreviewState(Object.fromEntries(parseVariantKey(next)));
        };
        for (const p of stateProps) {
          out.push({
            id: `sv.when.${p.name}`,
            name: p.name,
            category: c,
            value: when[p.name] ?? "",
            kind: "enum",
            options: ["", ...p.values],
            optionLabel: (o) => (o ? o : t("Any")),
            readOnly: ro,
            description: t("The value the state must have for this variant to show — Any: whatever it is."),
            onCommit: (v) => setWhen(p.name, String(v) || undefined),
          });
        }
        out.push(
          list("sv.models", t("Models"), c, modelNames(states.variants![key]), (v) => {
            if (v?.length) editStates((st) => void (st.variants![key] = modelNamesValue(v)));
          }, {
            suggestions: stateModelNames,
            validate: (v) => {
              const names = String(v).split(",").map((x) => x.trim()).filter(Boolean);
              if (!names.length) return t("A model name, or a list of them.");
              const missing = names.find((n) => !states.models?.[n]);
              return missing ? t("{name}: not in the state models", { name: missing }) : null;
            },
            description: t("The state model it shows; several, comma-separated, are picked at random per position. Turning for Facing and Attaches is added."),
          }),
          {
            id: "sv.shown",
            name: t("Shown For"),
            category: c,
            value: t("{n} of {total} states", { n: statesShowing(states, key), total: stateCount(stateProps) }),
            kind: "string",
            readOnly: true,
            description: t("The states it's the first match for — a variant above it that matches too wins."),
          }
        );
        if (problems.length) {
          out.push({
            id: "sv.problems",
            name: t("Problems"),
            category: c,
            value: problems.map((x) => t(x.message, x.params)).join("; "),
            kind: "string",
            readOnly: true,
          });
        }
      }
    }

    // The model.
    const mc = t("Model");
    const setM = (edit: (m: Model) => void) => update((d) => edit(ensureModel(d, effectiveKey)));
    out.push(
      text("parent", t("Parent"), mc, model?.parent, (v) => setM((m) => void (m.parent = v)), {
        suggestions: TEMPLATES.filter((x) => (modelKind === "item" ? true : !x.sprite)).map((x) => x.name),
        description: t("A template (cube_all, cube_column, …, generated, handheld for items) or any model id. Empty: the model's own elements."),
      })
    );
    if (!resolved.sprite) {
      out.push(
        flag("ambient_occlusion", t("Ambient Occlusion"), mc, model?.ambient_occlusion, (v) => setM((m) => void (m.ambient_occlusion = v)), true),
        choice("gui_light", t("GUI Light"), mc, model?.gui_light, ["front", "side"], (v) => setM((m) => void (m.gui_light = v as Model["gui_light"])))
      );
    }

    // Textures.
    const tc = t("Textures");
    for (const slot of resolved.slots) {
      const own = model?.textures?.[slot];
      const shown = resolved.textures[slot];
      const src = shown ? shownImages[shown] : undefined;
      out.push({
        id: `tex:${slot}`,
        name: slot,
        category: tc,
        value: own ?? "",
        displayValue: own ?? (shown ? `${shown} ${t("(inherited)")}` : ""),
        image: src?.url,
        kind: "string",
        suggestions: [...resolved.slots.filter((s) => s !== slot).map((s) => `#${s}`), ...choices.textures],
        readOnly: ro,
        description: t("@Set.name (a .yres image), a png path under resources/, a texture id (minecraft:block/stone) or #slot."),
        onCommit: (v) =>
          setM((m) => {
            const s = String(v).trim();
            m.textures ??= {};
            if (s) m.textures[slot] = s;
            else delete m.textures[slot];
            if (!Object.keys(m.textures).length) delete m.textures;
          }),
      });
    }

    // Display.
    if (displaySlot) {
      const dc = `${t("Display")}: ${displaySlot}`;
      const cur = resolved.display[displaySlot] ?? {};
      const setD = (k: keyof DisplayTransform, v: number[] | undefined) =>
        setM((m) => {
          m.display ??= {};
          const tr = { ...cur, ...(m.display[displaySlot] ?? {}) };
          if (v) tr[k] = v as Vec3;
          else delete tr[k];
          m.display[displaySlot] = tr;
        });
      out.push(
        vec("d.rotation", t("Rotation"), dc, cur.rotation, 3, (v) => setD("rotation", v), -180, 180),
        vec("d.translation", t("Translation"), dc, cur.translation, 3, (v) => setD("translation", v), -80, 80),
        vec("d.scale", t("Scale"), dc, cur.scale, 3, (v) => setD("scale", v), 0, 4)
      );
    }

    // The selected element and face.
    if (selEl && sel !== null) {
      const ec = t("Element");
      const setE = (edit: (e: Element) => void) => editElements((els) => edit(els[sel]));
      const r = selEl.rotation;
      out.push(
        text("e.name", t("Name"), ec, selEl.name, (v) => setE((e) => void (e.name = v))),
        vec("e.from", t("From"), ec, selEl.from, 3, (v) => v && setE((e) => void (e.from = v as Vec3)), -16, 32, false),
        vec("e.to", t("To"), ec, selEl.to, 3, (v) => v && setE((e) => void (e.to = v as Vec3)), -16, 32, false),
        choice("e.axis", t("Rotation Axis"), ec, r?.axis ?? "y", ["x", "y", "z"], (v) =>
          setE((e) => void (e.rotation = { origin: [8, 8, 8], angle: 0, ...(e.rotation ?? {}), axis: (v ?? "y") as Axis }))
        ),
        {
          id: "e.angle",
          name: t("Rotation Angle"),
          category: ec,
          value: String(r?.angle ?? 0),
          kind: "enum",
          options: ANGLES.map(String),
          readOnly: ro,
          description: t("Minecraft allows one axis and -45, -22.5, 0, 22.5 or 45 degrees."),
          onCommit: (v) =>
            setE((e) => {
              const angle = Number(v);
              if (!angle && (!e.rotation?.origin || vecText(e.rotation.origin) === "8, 8, 8")) delete e.rotation;
              else e.rotation = { axis: "y", origin: [8, 8, 8], ...(e.rotation ?? {}), angle };
            }),
        },
        vec("e.origin", t("Rotation Origin"), ec, r?.origin ?? [8, 8, 8], 3, (v) => setE((e) => void (e.rotation = { axis: "y", angle: 0, ...(e.rotation ?? {}), origin: (v ?? [8, 8, 8]) as Vec3 })), -16, 32),
        flag("e.rescale", t("Rescale"), ec, r?.rescale, (v) => setE((e) => void (e.rotation && (e.rotation.rescale = v))), false, { readOnly: ro || !r?.angle }),
        flag("e.shade", t("Shade"), ec, selEl.shade, (v) => setE((e) => void (e.shade = v)), true)
      );
      const fc = t("Faces");
      for (const d of DIRS) {
        out.push({
          id: `e.face.${d}`,
          name: t(d),
          category: fc,
          value: !!selEl.faces[d],
          kind: "bool",
          readOnly: ro,
          onCommit: (v) =>
            setE((e) => {
              if (v) e.faces[d] = { texture: `#${resolved.slots[0] ?? "0"}` };
              else delete e.faces[d];
            }),
        });
      }
      const f = face ? selEl.faces[face] : undefined;
      if (face && f) {
        const c = `${t("Face")}: ${t(face)}`;
        const setF = (edit: (x: NonNullable<Element["faces"][Dir]>) => void) => setE((e) => edit(e.faces[face]!));
        out.push(
          choice("f.texture", t("Texture"), c, f.texture.replace(/^#/, ""), resolved.slots, (v) => v && setF((x) => void (x.texture = `#${v}`))),
          vec("f.uv", t("UV"), c, f.uv, 4, (v) => setF((x) => void (x.uv = v as Uv | undefined)), 0, 16),
          choice("f.rotation", t("UV Rotation"), c, String(f.rotation ?? 0), ["0", "90", "180", "270"], (v) => setF((x) => void (x.rotation = v && v !== "0" ? Number(v) : undefined))),
          choice("f.cullface", t("Cull Face"), c, f.cullface, DIRS, (v) => setF((x) => void (x.cullface = v as Dir | undefined)), {
            description: t("Not drawn when a full block is on that side."),
          }),
          num("f.tint", t("Tint Index"), c, f.tint, (v) => setF((x) => void (x.tint = v)), { min: 0, int: true })
        );
      }
    }
    // A picked property, state model or variant is the object shown: its rows (a model's with its model's).
    if (kind === "block" && pickedState && states) {
      const file = new Set([t("General"), t("Block"), t("Item"), t("States")]);
      return out.filter((r) => !file.has(r.category ?? "") && (pickedState.kind === "model" || /^s[pmv]\./.test(r.id)));
    }
    return out;
    // `t` and the helpers read fresh state each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, kind, model, resolved, mainResolved, shownImages, choices, blockKinds, blockRefs, entityRefs, effectRefs, displaySlot, selEl, sel, face, readOnly, effectiveKey, modelKind, modelKey, pickedState, stateProps]);

  // ── Layout ────────────────────────────────────────────────────────────────

  if (!parsed.ok) {
    return (
      <div className="content-editor content-broken">
        <p>{t("This file isn't valid JSON: {error}", { error: parsed.error })}</p>
        <Button onClick={viewCode}>{t("View Code")}</Button>
      </div>
    );
  }

  const modelChoices: { value: ModelKey; label: string }[] = [{ value: "model", label: kind === "block" ? t("Block Model") : t("Item Model") }];
  if (kind === "block") {
    modelChoices.push({ value: "item_model", label: file.item_model ? t("Item Model") : t("Item Model (add)") });
    if (file.states?.connect) modelChoices.push({ value: "arm", label: t("Connection Arm") });
  }
  for (const n of kind === "block" ? stateModelNames : []) modelChoices.push({ value: stateModelKey(n), label: t("State Model: {name}", { name: n }) });
  const pickModel = (v: ModelKey) => {
    if (shownVariant && variantModelKey(shownVariant.models) !== v) setPreviewState(null);
    const state = stateModelOf(v);
    setStateSel(state !== null ? { kind: "model", key: state } : null);
    if (v === "item_model" && !file.item_model) update((d) => void (d.item_model = { parent: "generated", textures: { layer0: mainResolved.textures[mainResolved.slots[0]] ?? "minecraft:item/apple" } }));
    setModelKey(v);
    setSelected(null);
    setFace(null);
  };

  const faceData = selEl && face ? selEl.faces[face] : undefined;
  const faceTexture = faceData ? resolved.textures[faceData.texture.replace(/^#/, "")] : undefined;
  const otherUvs =
    selEl && face && faceData
      ? DIRS.filter((d) => d !== face && selEl.faces[d]?.texture === faceData.texture).map((d) => selEl.faces[d]!.uv ?? autoUv(d, selEl.from, selEl.to))
      : [];

  // The 2D paint view: the active slot's texture, the selected element's faces on it outlined.
  const activeImg = pixelsOf(activeKey);
  const overlays: { rect: [number, number, number, number]; primary?: boolean }[] = [];
  if (paintOn && activeImg && activeSlot && selEl && !resolved.sprite) {
    const sx = (activeAnim?.frameWidth ?? activeImg.w) / 16;
    const sy = (activeAnim?.frameHeight ?? activeImg.h) / 16;
    for (const d of DIRS) {
      const f = selEl.faces[d];
      if (!f || f.texture.replace(/^#/, "") !== activeSlot) continue;
      const [u0, v0, u1, v1] = f.uv ?? autoUv(d, selEl.from, selEl.to);
      overlays.push({ rect: [u0 * sx, v0 * sy, u1 * sx, v1 * sy], primary: d === face });
    }
  }
  const activeForeign = !!activeKey && !!images[activeKey] && !images[activeKey]!.writable;
  const spriteNote = resolved.sprite
    ? t("Paint the layers here or right on the model. To shape the item in 3D, convert it to elements.")
    : null;

  const paintPanel = paintOn && (
    <>
      <div className="content-pane-header">
        <span>{t("Paint")}</span>
        <Spacer />
        <Button variant="ghost" onClick={() => void newTexture()} title={t("A blank texture for the slot being painted")}>
          {t("New Texture…")}
        </Button>
      </div>
      <PaintTools paint={paint} onChange={setPaint} disabled={readOnly} />
    </>
  );

  const layersPanel = resolved.sprite && (
    <>
      <div className="content-pane-header">
        <span>{t("Layers")}</span>
        <Spacer />
        <IconButton title={t("Add Layer")} disabled={readOnly} onClick={addLayer}>
          <Icon name="plus" />
        </IconButton>
        <IconButton title={t("Move Up")} disabled={readOnly || !activeSlot || layerIndex(activeSlot) <= 0} onClick={() => activeSlot && moveLayer(activeSlot, -1)}>
          <Icon name="arrowUp" />
        </IconButton>
        <IconButton
          title={t("Move Down")}
          disabled={readOnly || !activeSlot || layerIndex(activeSlot) < 0 || layerIndex(activeSlot) >= layers.length - 1}
          onClick={() => activeSlot && moveLayer(activeSlot, 1)}
        >
          <Icon name="arrowDown" />
        </IconButton>
        <IconButton title={t("Remove Layer")} disabled={readOnly || layers.length < 2 || !activeSlot} onClick={() => activeSlot && removeLayer(activeSlot)}>
          <Icon name="trash" />
        </IconButton>
      </div>
      <ul className="content-elements content-layers" role="listbox">
        {[...layers].reverse().map((slot) => {
          const value = resolved.textures[slot];
          const index = layerIndex(slot);
          return (
            <li key={slot} role="option" aria-selected={slot === activeSlot} className={slot === activeSlot ? "selected" : undefined} onClick={() => setPaintSlot(slot)}>
              <span className="content-layer-thumb">{value && shownImages[value] && <img src={shownImages[value]!.url} alt="" />}</span>
              <span className="content-element-name" title={value}>
                {slot}
                <span className="content-element-size"> {value ?? ""}</span>
              </span>
              <label className="content-tint" title={t("Tint preview (tint index {n}) — right-click to clear", { n: index })} onClick={(e) => e.stopPropagation()}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTints(({ [index]: _, ...rest }) => rest);
                }}
              >
                <span style={{ background: tints[index] ?? "transparent" }} />
                <input type="color" value={tints[index] ?? "#ffffff"} onChange={(e) => setTints((m) => ({ ...m, [index]: e.target.value }))} />
              </label>
            </li>
          );
        })}
      </ul>
      <p className="content-note">{spriteNote}</p>
      <div className="content-pane-actions">
        <Button variant="subtle" disabled={readOnly} onClick={() => void convertToElements()}>
          {t("Convert to 3D Elements")}
        </Button>
      </div>
    </>
  );

  const elementsPanel = !resolved.sprite && (
    <>
      <div className="content-pane-header">
        <span>{t("Elements")}</span>
        <Spacer />
        <IconButton title={t("Add Element")} disabled={readOnly} onClick={addElement}>
          <Icon name="plus" />
        </IconButton>
        <IconButton title={withShortcut("Duplicate", "ctrl+d")} disabled={readOnly || sel === null} onClick={duplicateElement}>
          <Icon name="split" />
        </IconButton>
        <IconButton title={t("Move Up")} disabled={readOnly || sel === null || sel === 0} onClick={() => moveElement(-1)}>
          <Icon name="arrowUp" />
        </IconButton>
        <IconButton title={t("Move Down")} disabled={readOnly || sel === null || sel === elements.length - 1} onClick={() => moveElement(1)}>
          <Icon name="arrowDown" />
        </IconButton>
        <IconButton title={`${t("Delete")} (Del)`} disabled={readOnly || sel === null} onClick={deleteElement}>
          <Icon name="trash" />
        </IconButton>
      </div>
      {!resolved.own && elements.length > 0 && (
        <p className="content-note">{t("These elements come from {parent}. Editing one copies them into this model.", { parent: model?.parent ?? "" })}</p>
      )}
      <ul className="content-elements" role="listbox">
        {elements.map((el, i) => (
          <li key={i} role="option" aria-selected={i === sel} className={i === sel ? "selected" : undefined} onClick={() => onSelect(i, null)}>
            <Icon name={i === sel ? "check" : "grid"} size={13} />
            <span className="content-element-name">{el.name ?? `${t("Element")} ${i + 1}`}</span>
            <span className="content-element-size">
              {el.to.map((x, k) => fmt(x - el.from[k])).join("×")}
              {el.rotation?.angle ? ` ↻${el.rotation.angle}°${el.rotation.axis}` : ""}
            </span>
          </li>
        ))}
      </ul>
      {selEl && (
        <div className="content-faces">
          {DIRS.map((d) => (
            <button key={d} type="button" className={`content-face${face === d ? " selected" : ""}${selEl.faces[d] ? "" : " off"}`} onClick={() => onSelect(sel, d)}>
              {t(d)}
            </button>
          ))}
        </div>
      )}
    </>
  );

  // The block's states: its properties, its other models, which state shows which.
  const builtInOption: Record<string, string> = { facing: t("Facing"), face: t("Attaches"), waterlogged: t("Waterloggable") };
  const isPicked = (what: StateSel["kind"], key: string) => pickedState?.kind === what && pickedState.key === key;
  const pickedVariant = pickedState?.kind === "variant" ? pickedState.key : null;
  const variantKeys = Object.keys(states?.variants ?? {});
  const statesPanel = kind === "block" && (
    <>
      <div className="content-pane-header">
        <span>{t("State Properties")}</span>
        <Spacer />
        <IconButton title={t("Add State Property")} disabled={readOnly} onClick={() => void addStateProperty()}>
          <Icon name="plus" />
        </IconButton>
        <IconButton title={t("Remove State Property")} disabled={readOnly || pickedState?.kind !== "property"} onClick={() => pickedState && removeStateItem(pickedState)}>
          <Icon name="trash" />
        </IconButton>
      </div>
      <ul className="content-elements" role="listbox" aria-label={t("State Properties")}>
        {stateProps.map((p) => {
          const pk = propertyKind(p.values);
          const summary = pk === "bool" ? t("yes/no") : pk === "range" ? `${Math.min(...p.values.map(Number))}–${Math.max(...p.values.map(Number))}` : p.values.join(", ");
          return p.own ? (
            <li key={p.name} role="option" aria-selected={isPicked("property", p.name)} className={isPicked("property", p.name) ? "selected" : undefined} title={p.values.join(", ")} onClick={() => pickState({ kind: "property", key: p.name })}>
              <Icon name="list" size={13} />
              <span className="content-element-name">{p.name}</span>
              <span className="content-element-size content-state-values">{summary}</span>
            </li>
          ) : (
            <li key={p.name} className="content-state-builtin" title={t("Made by {option} — set it in Properties.", { option: builtInOption[p.name] })}>
              <Icon name="settings" size={13} />
              <span className="content-element-name">{p.name}</span>
              <span className="content-element-size content-state-values">{summary}</span>
            </li>
          );
        })}
      </ul>
      {!stateProps.length && <p className="content-note">{t("One state only. Set Facing, Attaches or Waterloggable in Properties, or add a property of the block's own.")}</p>}
      <div className="content-pane-header">
        <span>{t("State Models")}</span>
        <Spacer />
        <IconButton title={t("Add State Model")} disabled={readOnly} onClick={() => void addStateModel()}>
          <Icon name="plus" />
        </IconButton>
        <IconButton title={t("Remove State Model")} disabled={readOnly || pickedState?.kind !== "model"} onClick={() => pickedState && removeStateItem(pickedState)}>
          <Icon name="trash" />
        </IconButton>
      </div>
      <ul className="content-elements" role="listbox" aria-label={t("State Models")}>
        {stateModelNames.map((n) => (
          <li key={n} role="option" aria-selected={isPicked("model", n)} className={isPicked("model", n) ? "selected" : undefined} onClick={() => pickState({ kind: "model", key: n })}>
            <Icon name={effectiveKey === stateModelKey(n) ? "check" : "grid"} size={13} />
            <span className="content-element-name">{n}</span>
          </li>
        ))}
      </ul>
      <div className="content-pane-header">
        <span>{t("Variants")}</span>
        <Spacer />
        <IconButton title={t("Add Variant")} disabled={readOnly || !stateProps.length} onClick={addVariant}>
          <Icon name="plus" />
        </IconButton>
        <IconButton title={t("Move Up")} disabled={readOnly || !pickedVariant || variantKeys.indexOf(pickedVariant) <= 0} onClick={() => pickedVariant !== null && moveStateVariant(pickedVariant, -1)}>
          <Icon name="arrowUp" />
        </IconButton>
        <IconButton
          title={t("Move Down")}
          disabled={readOnly || pickedVariant === null || variantKeys.indexOf(pickedVariant) >= variantKeys.length - 1}
          onClick={() => pickedVariant !== null && moveStateVariant(pickedVariant, 1)}
        >
          <Icon name="arrowDown" />
        </IconButton>
        <IconButton title={t("Remove Variant")} disabled={readOnly || pickedVariant === null} onClick={() => pickedState && removeStateItem(pickedState)}>
          <Icon name="trash" />
        </IconButton>
      </div>
      <ul className="content-elements" role="listbox" aria-label={t("Variants")}>
        {variantKeys.map((k) => {
          const problems = variantProblems(states!, k).map((x) => t(x.message, x.params));
          if (!problems.length && !statesShowing(states!, k)) problems.push(t("Never shown: a variant above it matches every state it would."));
          return (
            <li
              key={k}
              role="option"
              aria-selected={isPicked("variant", k)}
              className={isPicked("variant", k) ? "selected" : undefined}
              title={problems.length ? problems.join("\n") : undefined}
              onClick={() => pickState({ kind: "variant", key: k })}
            >
              <Icon name={problems.length ? "warning" : shownVariant?.key === k ? "preview" : "split"} size={13} />
              <span className="content-element-name">{k || t("Every state")}</span>
              <span className="content-element-size content-state-values">{modelNames(states!.variants![k]).join(", ")}</span>
            </li>
          );
        })}
      </ul>
      {stateProps.length > 0 && !variantKeys.length && <p className="content-note">{t("Every state shows the block's model. Add a variant to show another model in some states.")}</p>}
    </>
  );

  // The state the view shows: each property's value, and what that shows.
  const shownModel = shownVariant ? (shownVariant.models.length ? shownVariant.models.join(" | ") : t("the block's model")) : "";
  const stateLabel = shownState ? `${t("State")}: ${stateProps.map((p) => `${p.name}=${shownState[p.name]}`).join(", ")}` : t("No State");
  const stateMenuItems: ContextMenuItem[] = [
    { label: t("No State — the Model Unturned"), checked: !shownState, onSelect: () => showState(null) },
    { label: t("Default State"), onSelect: () => showState(defaultState(stateProps)) },
    ...stateProps.map((p, i) => ({
      label: shownState ? `${p.name} = ${shownState[p.name]}` : p.name,
      separatorBefore: i === 0,
      submenu: p.values.map((v) => ({
        label: v,
        checked: shownState?.[p.name] === v,
        onSelect: () => showState({ ...(shownState ?? defaultState(stateProps)), [p.name]: v }),
      })),
    })),
    ...(shownVariant
      ? [{ label: t("Shows {model}, turned x {x}° y {y}°", { model: shownModel, x: shownVariant.x, y: shownVariant.y }), disabled: true, separatorBefore: true }]
      : []),
  ];

  // What Properties shows while this editor is active: the selected
  // element (or the file's own fields), the face's UV under them.
  const uvRow: PropertyDescriptor | null =
    !paintOn && faceData && face && selEl
      ? {
          id: "uv",
          category: t("UV"),
          name: t("UV"),
          value: null,
          render: () => (
            <div className="content-uv-pane">
                <div className="content-pane-header">
                  <span>
                    {t("UV")}: {t(face)}
                  </span>
                  <Spacer />
                  <Button variant="ghost" disabled={readOnly || !faceData.uv} onClick={() => editElements((els) => void delete els[sel!].faces[face]!.uv)}>
                    {t("Auto UV")}
                  </Button>
                </div>
                <UvEditor
                  image={faceTexture ? shownImages[faceTexture] : undefined}
                  uv={faceData.uv ?? autoUv(face, selEl.from, selEl.to)}
                  others={otherUvs}
                  readOnly={readOnly}
                  onCommit={(uv) => editElements((els) => void (els[sel!].faces[face]!.uv = uv))}
                />
              </div>
          ),
        }
      : null;
  usePropertyContext(path, {
    // A picked property's or variant's rows as declared: name, kind, values; conditions, models.
    order: pickedState && !selEl ? "declared" : "sorted",
    objectName: selEl
      ? (selEl.name ?? `${t("Element")} ${(sel ?? 0) + 1}`)
      : pickedState
        ? pickedState.key || t("Every state")
        : (file.name ?? path.split(/[\\/]/).pop()),
    objectType: selEl ? t("Element") : pickedState ? t(STATE_SEL_TYPES[pickedState.kind]) : kind === "block" ? t("Block") : t("Item"),
    objectKey: `${effectiveKey}:${sel ?? "-"}:${face ?? "-"}:${pickedState ? `${pickedState.kind}:${pickedState.key}` : "-"}`,
    properties: uvRow ? [...properties, uvRow] : properties,
  });

  return (
    <div className="content-editor" ref={rootRef}>
      <Toolbar>
        <ToolbarGroup>
          <ToolbarSelect value={effectiveKey} options={modelChoices} onChange={(v) => pickModel(v as ModelKey)} />
        </ToolbarGroup>
        {stateProps.length > 0 && (
          <ToolbarGroup>
            <ToolbarButton
              icon="preview"
              label={stateLabel.length > 48 ? `${stateLabel.slice(0, 47)}…` : stateLabel}
              tooltip={shownVariant ? `${stateLabel}\n${t("Shows {model}, turned x {x}° y {y}°", { model: shownModel, x: shownVariant.x, y: shownVariant.y })}` : t("The block state the view shows: the model its variant picks, turned as the block stands")}
              showLabel
              dropdown
              onClick={(e) => stateMenu.openAtPoint(undefined, belowButton(e))}
            />
            <ContextMenu target={stateMenu.target} items={stateMenuItems} onClose={stateMenu.close} />
          </ToolbarGroup>
        )}
        <ToolbarGroup>
          <ToolbarModes
            showLabels
            value={paintOn ? "paint" : gizmo}
            onChange={(m) => (m === "paint" ? setPaintMode(true) : pickGizmo(m))}
            modes={[
              { value: "move", label: "Move", shortcut: "g", disabled: !!resolved.sprite },
              { value: "resize", label: "Resize", shortcut: "s", disabled: !!resolved.sprite },
              { value: "paint", label: "Paint", shortcut: "p", disabled: readOnly },
            ]}
          />
        </ToolbarGroup>
        <ToolbarGroup>
          <ToolbarCheck label="Shading" checked={shading} onChange={setShading} />
          <ToolbarCheck label="Grid" checked={grid} onChange={setGrid} />
          <ToolbarSelect
            value=""
            options={[
              { value: "", label: t("View…") },
              { value: "front", label: withShortcut("Front", "1") },
              { value: "right", label: withShortcut("Right", "3") },
              { value: "top", label: withShortcut("Top", "7") },
              { value: "back", label: withShortcut("Back", "ctrl+1") },
              { value: "left", label: withShortcut("Left", "ctrl+3") },
              { value: "bottom", label: withShortcut("Bottom", "ctrl+7") },
            ]}
            onChange={(v) => v && setViewRequest({ view: v as ViewName, key: Date.now() })}
          />
        </ToolbarGroup>
        <ToolbarGroup>
          <ToolbarSelect
            value={displaySlot}
            options={[{ value: "", label: t("No display transform") }, ...DISPLAY_SLOTS.map((s) => ({ value: s, label: s }))]}
            onChange={(v) => setDisplaySlot(v as DisplaySlot | "")}
          />
          {displaySlot && model?.display?.[displaySlot] && (
            <ToolbarButton label="Reset" disabled={readOnly} onClick={() => update((d) => void delete ensureModel(d, effectiveKey).display?.[displaySlot])} />
          )}
          {rotations.length > 1 && effectiveKey === "model" && (
            <ToolbarSelect
              value={String(Math.min(variant, rotations.length - 1))}
              options={rotations.map((r, i) => ({ value: String(i), label: `${t("Variant")} ${i + 1} (x${r.x ?? 0} y${r.y ?? 0})` }))}
              onChange={(v) => setVariant(Number(v))}
            />
          )}
        </ToolbarGroup>
        <ToolbarGroup>
          <ToolbarButton icon="plus" label="Texture Slot…" showLabel disabled={readOnly} onClick={() => void addSlot()} />
        </ToolbarGroup>
        <Spacer />
        <ToolbarButton icon="code" label="View Code" shortcut="f7" onClick={viewCode} />
      </Toolbar>
      <div className="content-body">
        <div className="content-outliner">
          {paintPanel}
          {layersPanel}
          {elementsPanel}
          {statesPanel}
        </div>
        <div className="content-center">
          {paintOn && (
            <div className="content-paint">
              <div className="content-pane-header">
                <SelectField
                  aria-label={t("Texture")}
                  value={activeSlot ?? ""}
                  options={paintSlots.map((s) => ({ value: s, label: `${s}: ${resolved.textures[s]}` }))}
                  onChange={(v) => setPaintSlot(v)}
                />
                {activeForeign && <span className="content-paint-note">{t("Not the mod's texture — the first stroke copies it into the mod.")}</span>}
                <Spacer />
                {activeKey && activeImg && !activeAnim && !activeForeign && (
                  <ToolbarButton icon="play" label="Animate" showLabel tooltip="Make it an animated texture: frames, played in game (.png.mcmeta)" disabled={readOnly} onClick={() => editAnimation(activeKey, stillAnimation(activeImg))} />
                )}
              </div>
              <PaintCanvas
                className="content-paint-canvas"
                image={activeImg ? (activeAnim ? cropFrame(activeImg, activeAnim, activeFrame) : activeImg) : null}
                overlays={overlays}
                grid={paint.grid}
                brushSize={paint.tool === "pencil" || paint.tool === "eraser" || paint.tool === "line" ? paint.size : 1}
                mirrorX={paint.mirrorX}
                onPaint={readOnly ? undefined : onCanvasPaint}
                emptyText={activeKey ? t("Loading {texture}…", { texture: activeKey }) : t("No texture to paint. Use New Texture… or set a texture slot.")}
              />
              {activeKey && activeImg && activeAnim && (
                <FrameStrip
                  image={activeImg}
                  animation={activeAnim}
                  selected={activeEntry}
                  onSelect={(n) => setPaintEntry((m) => ({ ...m, [activeKey]: n }))}
                  playing={playing}
                  onPlaying={setPlaying}
                  onChange={(animation, img) => editAnimation(activeKey, animation, img)}
                  readOnly={readOnly || activeForeign}
                />
              )}
            </div>
          )}
          <Viewport
            className="content-viewport"
            parts={parts}
            images={shownImages}
            selected={sel}
            selectedFace={face}
            onSelect={onSelect}
            onTransform={readOnly || paintOn ? undefined : onTransform}
            onPaint={paintOn ? onViewportPaint : null}
            gizmo={gizmo}
            shading={shading}
            showGrid={grid}
            renderLayer={file.block?.render_layer}
            display={display}
            viewRequest={viewRequest}
          />
        </div>
      </div>
    </div>
  );
}
