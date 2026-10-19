// The .yblock/.yitem editor's model side: which model is edited, how one is
// drawn (parents and templates resolved), what's picked, what's painted.

import type { TextureSource } from "../../content/Viewport";
import type { TextureAnimation } from "../../content/animation";
import { type ContentFile, defaultDisplay, type Dir, DIRS, type DisplaySlot, type DisplayTransform, type Element, type Model, SLOT_REF, templateElements, templateOf, type Kind } from "../../content/model";
import type { PixelImage } from "../../content/paint/pixels";
import { GAME_NAMESPACE } from "../../data/yogFormat";
import { kind as KIND } from "../../data/yogIds.generated";

/** What the pickers offer, from the mod and the game. */
export interface Choices {
  /** The mod's id: its own textures' namespace. */
  modId: string;
  textures: string[];
  strings: string[];
  sounds: string[];
  tags: string[];
  toolMaterials: string[];
  armorMaterials: string[];
}
export const NO_CHOICES: Choices = { modId: GAME_NAMESPACE, textures: [], strings: [], sounds: [], tags: [], toolMaterials: [], armorMaterials: [] };

export interface BuiltInBlockKind {
  name: string;
  takes: string[];
  occludes?: boolean;
}

export interface PotionEffectRow extends Record<string, unknown> {
  effect?: string;
  duration?: number;
  amplifier?: number;
}

/** The file's own models: the block's or item's, its item form's, the connection arm. */
/** The `.yblock`/`.yitem` source view's id (View Code, F7). */
export const CONTENT_SOURCE_VIEW = "yog.content.source";

export const MODEL = { main: "model", item: "item_model", arm: "arm" } as const;

/** A new state model's name, before it's made unique. */
export const NEW_STATE_MODEL = "variant";

/** A state model's key prefix (`states.models`). */
export const STATE_MODEL = "state:";

/** Which model of the file is being edited: one of [`MODEL`], or a state model. */
export type ModelKey = (typeof MODEL)[keyof typeof MODEL] | `${typeof STATE_MODEL}${string}`;
export const stateModelKey = (name: string): ModelKey => `${STATE_MODEL}${name}`;
/** The state model's name a key stands for, if it's one. */
export const stateModelOf = (key: ModelKey): string | null => (key.startsWith(STATE_MODEL) ? key.slice(STATE_MODEL.length) : null);

/** A raw parent model (`content_parent_model`), parents flattened. */
export interface ParentModel {
  textures?: Record<string, string>;
  elements?: Element[];
  display?: Partial<Record<DisplaySlot, DisplayTransform>>;
  parent?: string;
}

/** A model as drawn: its elements (own, a template's, or a parent's), textures resolved, display. */
export interface Resolved {
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

/** How many `#ref` hops a texture value may take before it counts as a loop. */
const MAX_TEXTURE_REFS = 16;

export const isSpriteParent = (p?: string) => !!p && /(^|[:/])(generated|handheld)$|builtin\/generated/.test(p);

export function modelOf(f: ContentFile, key: ModelKey): Model | undefined {
  if (key === MODEL.arm) return f.states?.connect?.arm;
  const state = stateModelOf(key);
  if (state !== null) return f.states?.models?.[state];
  return f[key as typeof MODEL.main | typeof MODEL.item];
}

export function ensureModel(f: ContentFile, key: ModelKey): Model {
  if (key === MODEL.arm) {
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
  return (f[key as typeof MODEL.main | typeof MODEL.item] ??= {});
}

/** Every model of the file: the block's or item's, the item form's, the arm, the state models. */
export const allModels = (f: ContentFile): (Model | undefined)[] => [f.model, f.item_model, f.states?.connect?.arm, ...Object.values(f.states?.models ?? {})];

export function resolve(model: Model | undefined, kind: Kind, parents: Record<string, ParentModel | null>): Resolved {
  const m = model ?? {};
  const parent = m.parent;
  const tpl = templateOf(parent);
  const raw = parent && !tpl ? parents[parent] : undefined;
  const textures: Record<string, string> = { ...(raw?.textures ?? {}), ...(m.textures ?? {}) };
  const follow = (v: string | undefined): string | undefined => {
    for (let i = 0; i < MAX_TEXTURE_REFS && v?.startsWith(SLOT_REF); i++) v = textures[v.slice(1)];
    return v?.startsWith(SLOT_REF) ? undefined : v;
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
  else if (kind === KIND.ITEM && !m.elements?.length && !tpl) display = defaultDisplay("generated");
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

/** What can be picked in the outliner's States. */
export const STATE_PICK = { property: "property", model: "model", variant: "variant" } as const;

/** What's picked in the outliner's States. */
export interface StateSel {
  kind: (typeof STATE_PICK)[keyof typeof STATE_PICK];
  /** The property's, model's name; the variant's key. */
  key: string;
}

/** What the picked item is, for Properties' object line (translated). */
export const STATE_SEL_TYPES: Record<StateSel["kind"], string> = { property: "State Property", model: "State Model", variant: "Variant" };

/** A texture as loaded: its image, and whether it's the mod's own file (paintable in place). */
export type LoadedTexture = TextureSource & { writable: boolean };

/** A texture's animation as edited here: `null` = no override (the loaded one shows). */
export type AnimationEdit = { animation: TextureAnimation | null } | null;

/** A texture painted in the editor (not saved yet, or saved and still shown from memory). */
export interface Edited {
  img: PixelImage;
  url: string;
}

export const LAYER = /^layer(\d+)$/;
export const layerIndex = (slot: string) => Number(LAYER.exec(slot)?.[1] ?? -1);

/** Every texture value the file's models name. */
export function namedTextures(f: ContentFile): Set<string> {
  const out = new Set<string>();
  for (const m of allModels(f)) for (const v of Object.values(m?.textures ?? {})) out.add(v);
  return out;
}

export const ARM_TEMPLATE = (texture: string): Model => ({
  textures: { arm: texture },
  elements: [
    {
      from: [6, 6, 0],
      to: [10, 10, 6],
      faces: Object.fromEntries(DIRS.filter((d) => d !== "south").map((d) => [d, { texture: "#arm", ...(d === "north" ? { cullface: "north" as Dir } : {}) }])),
    },
  ],
});
