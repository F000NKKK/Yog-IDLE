// A `.yblock`'s block states as the editor sees them: the properties a state
// has (its own and the ones facing, attach and waterlogged make), which
// model each state shows (`states.variants`) and how it turns — as `yog
// build` makes the blockstate (yog-cli `content.rs`).

import type { BlockProps, ContentFile, Model } from "./model";

export type States = NonNullable<ContentFile["states"]>;

/** A property of the block's states: its values, the first the default. */
export interface StateProperty {
  name: string;
  values: string[];
  /** Declared in `states.properties` (else made by facing, attach or waterlogged). */
  own: boolean;
}

/** The facings' values, as the host makes the `facing` property. */
export const FACING_VALUES = {
  horizontal: ["north", "east", "south", "west"],
  all: ["north", "east", "south", "west", "up", "down"],
} as const;
/** An attached block's `face` property. */
export const FACE_VALUES = ["floor", "wall", "ceiling"] as const;
/** A yes/no property's values (a `powered` or `comparator` one must be exactly this). */
export const YES_NO = ["false", "true"] as const;
/** Names the host gives properties of its own. */
export const BUILT_IN_PROPERTIES = ["facing", "face", "waterlogged"] as const;

/** How a property's values are edited: yes/no, a run of whole numbers, or names. */
export const PROPERTY_KINDS = ["bool", "range", "values"] as const;
export type PropertyKind = (typeof PROPERTY_KINDS)[number];
/** How the kinds are shown (translated). */
export const PROPERTY_KIND_LABELS: Record<PropertyKind, string> = { bool: "Yes/No", range: "Number Range", values: "Values" };

/** A property's or value's name: lowercase letters, digits and `_`. */
export const isWord = (s: string) => /^[a-z0-9_]+$/.test(s);

const NUMBER = /^(0|[1-9]\d*)$/;

/** What the values are: yes/no, every whole number from one to another, else names. */
export function propertyKind(values: readonly string[]): PropertyKind {
  const set = new Set(values);
  if (set.size === 2 && set.has("false") && set.has("true")) return "bool";
  if (values.length >= 2 && values.every((v) => NUMBER.test(v))) {
    const ns = values.map(Number);
    if (Math.max(...ns) - Math.min(...ns) === values.length - 1 && set.size === values.length) return "range";
  }
  return "values";
}

/** `min`…`max`, `def` first (the default) when it's in it. */
export function rangeValues(min: number, max: number, def?: string): string[] {
  const all = Array.from({ length: max - min + 1 }, (_, i) => String(min + i));
  return def !== undefined && all.includes(def) ? [def, ...all.filter((v) => v !== def)] : all;
}

/** `values` with `def` first — the default state. */
export const withDefault = (values: readonly string[], def: string): string[] => (values.includes(def) ? [def, ...values.filter((v) => v !== def)] : [...values]);

/** What's wrong with a property's values (`yog build`'s rule), or null. */
export function valuesProblem(values: readonly string[]): string | null {
  if (values.length < 2) return "Two or more values.";
  if (!values.every(isWord)) return "Values are lowercase letters, digits and _.";
  if (new Set(values).size !== values.length) return "Each value once.";
  return null;
}

/** What's wrong with a new name for a property (`others`: the block's other properties), or null. */
export function propertyNameProblem(name: string, others: readonly string[]): string | null {
  if (!isWord(name)) return "Lowercase letters, digits and _.";
  if ((BUILT_IN_PROPERTIES as readonly string[]).includes(name)) return "facing, face and waterlogged come from Facing, Attaches and Waterloggable — name yours otherwise.";
  if (others.includes(name)) return "The block already has this property.";
  return null;
}

/** Every property of the block's states: facing, face, waterlogged as the host makes them, then its own. */
export function stateProperties(s: States | undefined): StateProperty[] {
  if (!s) return [];
  const out: StateProperty[] = [];
  const facing = s.attach ? "horizontal" : s.facing;
  if (facing) out.push({ name: "facing", values: [...FACING_VALUES[facing]], own: false });
  if (s.attach) out.push({ name: "face", values: [...FACE_VALUES], own: false });
  if (s.waterlogged) out.push({ name: "waterlogged", values: [...YES_NO], own: false });
  for (const [name, values] of Object.entries(s.properties ?? {})) out.push({ name, values, own: true });
  return out;
}

/** One state: a value for each property. */
export type BlockState = Record<string, string>;

/** The default state: each property's first value. */
export const defaultState = (props: readonly StateProperty[]): BlockState => Object.fromEntries(props.map((p) => [p.name, p.values[0]]));

/** How many states there are. */
export const stateCount = (props: readonly StateProperty[]) => props.reduce((n, p) => n * p.values.length, 1);

/** A variant's key (`"energized=true,facing=up"`) → its conditions, in order. */
export function parseVariantKey(key: string): [string, string][] {
  return key
    .split(",")
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf("=");
      return (i < 0 ? [pair, ""] : [pair.slice(0, i), pair.slice(i + 1)]) as [string, string];
    });
}

/** Conditions → a variant's key, in the properties' order. */
export function variantKey(when: Record<string, string>, props: readonly StateProperty[]): string {
  const names = [...props.map((p) => p.name), ...Object.keys(when).filter((k) => !props.some((p) => p.name === k))];
  return names
    .filter((n) => when[n] !== undefined && when[n] !== "")
    .map((n) => `${n}=${when[n]}`)
    .join(",");
}

/** A variant's model names (one, or several picked at random). */
export const modelNames = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
/** Model names as the file writes them: one as a string, several as a list. */
export const modelNamesValue = (names: readonly string[]): string | string[] => (names.length === 1 ? names[0] : [...names]);

/** What's wrong with a variant (no such property or value, no such model), or none. */
export function variantProblems(s: States, key: string): { message: string; params?: Record<string, string> }[] {
  const props = stateProperties(s);
  const out: { message: string; params?: Record<string, string> }[] = [];
  for (const [k, v] of parseVariantKey(key)) {
    if (!props.some((p) => p.name === k && p.values.includes(v))) out.push({ message: "{pair}: no such property and value", params: { pair: `${k}=${v}` } });
  }
  const names = modelNames(s.variants?.[key]);
  if (!names.length) out.push({ message: "A model name, or a list of them." });
  for (const n of names) if (!s.models?.[n]) out.push({ message: "{name}: not in the state models", params: { name: n } });
  return out;
}

/** How a state turns its model, x then y in degrees: `facing` is where its front (the model's north) looks; `face`, where an attached block hangs. */
export function turn(facing?: string, face?: string): { x: number; y: number } {
  const yaw = (f: string) => ({ east: 90, south: 180, west: 270 })[f as "east"] ?? 0;
  if (face === "wall" && facing) return { x: 90, y: yaw(facing) };
  if (face === "ceiling" && facing) return { x: 180, y: (yaw(facing) + 180) % 360 };
  if (facing === "up") return { x: 270, y: 0 };
  if (facing === "down") return { x: 90, y: 0 };
  if (facing) return { x: 0, y: yaw(facing) };
  return { x: 0, y: 0 };
}

/** What a state shows: the first variant that matches (`null`: none, the block's own model), its models, and the turn. */
export function variantOf(s: States | undefined, state: BlockState): { key: string | null; models: string[]; x: number; y: number } {
  const t = turn(state.facing, state.face);
  for (const [key, v] of Object.entries(s?.variants ?? {})) {
    if (parseVariantKey(key).every(([k, val]) => state[k] === val)) return { key, models: modelNames(v), ...t };
  }
  return { key: null, models: [], ...t };
}

/** Every state, the last property fastest (as the blockstate lists them) — at most `limit`. */
export function* allStates(props: readonly StateProperty[], limit = Infinity): Generator<BlockState> {
  if (!props.length) return;
  const at = props.map(() => 0);
  for (let n = 0; n < limit; n++) {
    yield Object.fromEntries(props.map((p, i) => [p.name, p.values[at[i]]]));
    let i = props.length - 1;
    while (i >= 0 && ++at[i] === props[i].values.length) at[i--] = 0;
    if (i < 0) return;
  }
}

/** How many states variant `key` is the one shown for. */
export function statesShowing(s: States, key: string, limit = 4096): number {
  let n = 0;
  for (const st of allStates(stateProperties(s), limit)) if (variantOf(s, st).key === key) n++;
  return n;
}

/** `o` with key `from` renamed `to`, in place in the order. */
function renameKey<T>(o: Record<string, T>, from: string, to: string): Record<string, T> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k === from ? to : k, v]));
}

/** The variants with each key's conditions rewritten (`null`: the variant goes). */
function mapKeys(s: States, edit: (when: [string, string][]) => [string, string][] | null) {
  if (!s.variants) return;
  const out: NonNullable<States["variants"]> = {};
  for (const [key, v] of Object.entries(s.variants)) {
    const when = edit(parseVariantKey(key));
    if (when) out[when.map(([k, val]) => `${k}=${val}`).join(",")] ??= v;
  }
  s.variants = Object.keys(out).length ? out : undefined;
}

/** Renames property `from` everywhere: its declaration, the variants, the block's powered/comparator. */
export function renameProperty(s: States, block: BlockProps | undefined, from: string, to: string) {
  if (!s.properties?.[from] || from === to) return;
  s.properties = renameKey(s.properties, from, to);
  mapKeys(s, (when) => when.map(([k, v]) => [k === from ? to : k, v]));
  if (block?.powered === from) block.powered = to;
  if (block?.comparator === from) block.comparator = to;
}

/** Removes property `name` and what refers to it (variants with it, the block's powered/comparator). */
export function removeProperty(s: States, block: BlockProps | undefined, name: string) {
  if (!s.properties?.[name]) return;
  const { [name]: _, ...rest } = s.properties;
  s.properties = Object.keys(rest).length ? rest : undefined;
  mapKeys(s, (when) => (when.some(([k]) => k === name) ? null : when));
  if (block?.powered === name) delete block.powered;
  if (block?.comparator === name) delete block.comparator;
}

/** Renames state model `from` everywhere: `states.models` and the variants. */
export function renameModel(s: States, from: string, to: string) {
  if (!s.models?.[from] || from === to) return;
  s.models = renameKey(s.models, from, to);
  for (const [k, v] of Object.entries(s.variants ?? {})) s.variants![k] = modelNamesValue(modelNames(v).map((n) => (n === from ? to : n)));
}

/** Removes state model `name`, from the variants too (one left without a model goes). */
export function removeModel(s: States, name: string) {
  if (!s.models?.[name]) return;
  const { [name]: _, ...rest } = s.models;
  s.models = Object.keys(rest).length ? rest : undefined;
  const variants: NonNullable<States["variants"]> = {};
  for (const [k, v] of Object.entries(s.variants ?? {})) {
    const left = modelNames(v).filter((n) => n !== name);
    if (left.length) variants[k] = modelNamesValue(left);
  }
  s.variants = Object.keys(variants).length ? variants : undefined;
}

/** Moves variant `key` up (`-1`) or down (`1`) — the first that matches wins. */
export function moveVariant(s: States, key: string, by: -1 | 1) {
  const entries = Object.entries(s.variants ?? {});
  const i = entries.findIndex(([k]) => k === key);
  if (i < 0 || i + by < 0 || i + by >= entries.length) return;
  [entries[i], entries[i + by]] = [entries[i + by], entries[i]];
  s.variants = Object.fromEntries(entries);
}

/** Sets variant `key`'s conditions to `when` (its place kept); false when another variant has them already. */
export function setVariantKey(s: States, key: string, next: string): boolean {
  if (key === next) return true;
  if (!s.variants || !(key in s.variants) || next in s.variants) return false;
  s.variants = renameKey(s.variants, key, next);
  return true;
}

/** A name not in `taken`: `base`, else `base2`, `base3`… */
export function freeName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}${n}`)) return `${base}${n}`;
}

/** Conditions for a new variant: the first property=value no variant has yet (`""`: all states). */
export function newVariantKey(s: States): string | null {
  const taken = new Set(Object.keys(s.variants ?? {}));
  for (const p of stateProperties(s)) for (const v of p.values) if (!taken.has(`${p.name}=${v}`)) return `${p.name}=${v}`;
  return taken.has("") ? null : "";
}

/** A state model: a copy of `model` (its textures to start from). */
export const stateModelFrom = (model: Model | undefined): Model => JSON.parse(JSON.stringify(model ?? { parent: "cube_all" })) as Model;
