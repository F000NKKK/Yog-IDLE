/**
 * Property grids generated from a format's schema (`yog schema`, the
 * CLI's `format.shape` — `yog_data::Shape::describe`): the same
 * definition `yog build` checks with, so an editor never lists a field the
 * build doesn't know or misses one it does. Nested structs become
 * categories, enums choices, a tagged enum its kind then that kind's
 * fields; lists of plain values are edited comma-separated, anything
 * deeper is shown and left to the code view.
 */

import type { PropertyDescriptor, PropertyValue } from "substrate-platform-ui";
import { shapeKind as K } from "./yogIds.generated";

export interface ShapeD {
  kind: string;
  /** Lists, maps, optionals: the item shape; references: the kinds. */
  of?: ShapeD | string[];
  /** `def`: the struct or enum in `defs`. */
  name?: string;
  min?: number;
  max?: number;
}

export interface FieldD {
  name: string;
  doc?: string;
  shape: ShapeD;
  required: boolean;
  range?: [number, number];
}

export type DefD =
  | { kind: typeof K.STRUCT; doc?: string; fields: FieldD[] }
  | { kind: typeof K.ENUM; doc?: string; tag?: string; variants: { name: string; doc?: string; fields?: FieldD[] }[] };

export interface Described {
  root: ShapeD;
  defs: Record<string, DefD>;
}

type Obj = Record<string, unknown>;

/** Shapes edited as one line of text. */
const PLAIN = new Set<string>([K.STRING, K.ATOM, K.TEXT, K.IMAGE, K.COLOR, K.RES, K.REF, K.TAG, K.REF_OR_TAG, K.REF_OR_IMAGE]);

/** `tool_level` → `Tool Level`. */
export function humanize(name: string): string {
  return name
    .split(/[_\-.]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function unwrap(s: ShapeD): ShapeD {
  return s.kind === K.OPTIONAL && s.of && !Array.isArray(s.of) ? unwrap(s.of) : s;
}

/** `obj` with `value` at `path` (`undefined` removes it, and objects left empty). */
export function setAt(obj: Obj, path: readonly string[], value: unknown): Obj {
  const [head, ...rest] = path;
  const next: Obj = { ...obj };
  if (rest.length === 0) {
    if (value === undefined) delete next[head];
    else next[head] = value;
    return next;
  }
  const child = next[head] && typeof next[head] === "object" && !Array.isArray(next[head]) ? (next[head] as Obj) : {};
  const updated = setAt(child, rest, value);
  if (Object.keys(updated).length === 0) delete next[head];
  else next[head] = updated;
  return next;
}

function getAt(obj: Obj, path: readonly string[]): unknown {
  let v: unknown = obj;
  for (const k of path) v = v && typeof v === "object" ? (v as Obj)[k] : undefined;
  return v;
}

/** A short text for a value the grid doesn't edit. */
function summary(v: unknown): string {
  if (v === undefined) return "";
  if (Array.isArray(v)) return `[${v.length}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).length}}`;
  return String(v);
}

/**
 * The rows for `value` of format `desc`; `set` gets the whole new value
 * after an edit. `t` translates the grid's own words.
 */
export function shapeProperties(
  desc: Described,
  value: Obj,
  set: (next: Obj) => void,
  t: (s: string, p?: Record<string, string | number>) => string,
  /** The file with its defaults (`format.complete`): shown where it leaves a field out. */
  shown?: Obj | null,
): PropertyDescriptor[] {
  const out: PropertyDescriptor[] = [];
  const general = t("General");

  const fields = (list: FieldD[], path: string[], category: string) => {
    for (const f of list) field(f, [...path, f.name], category);
  };

  const def = (s: ShapeD): DefD | undefined => (s.kind === K.DEF && s.name ? desc.defs[s.name] : undefined);

  const field = (f: FieldD, path: string[], category: string) => {
    const shape = unwrap(f.shape);
    const id = path.join(".");
    const current = getAt(value, path) ?? (shown ? getAt(shown, path) : undefined);
    const base = { id, name: t(humanize(f.name)), category, description: f.doc };
    const commit = (v: unknown) => set(setAt(value, path, v));
    const d = def(shape);
    if (d?.kind === K.STRUCT) {
      fields(d.fields, path, t(humanize(path.join(" "))));
      return;
    }
    if (d?.kind === K.ENUM && !d.tag) {
      out.push({
        ...base,
        description: f.doc ?? d.doc,
        value: typeof current === "string" ? current : "",
        kind: "enum",
        options: [...(f.required ? [] : [""]), ...d.variants.map((v) => v.name)],
        optionLabel: (v) => (v === "" ? "" : t(humanize(v))),
        onCommit: (v) => commit(v === "" ? undefined : v),
      });
      return;
    }
    if (shape.kind === K.BOOL) {
      out.push({ ...base, value: typeof current === "boolean" ? current : false, kind: "bool", onCommit: (v) => commit(v === false && !f.required ? undefined : Boolean(v)) });
      return;
    }
    if (shape.kind === K.INT || shape.kind === K.FLOAT) {
      const [lo, hi] = f.range ?? [shape.min ?? -Infinity, shape.max ?? Infinity];
      out.push({
        ...base,
        value: typeof current === "number" ? current : "",
        kind: "string",
        validate: (v: PropertyValue) => {
          const text = String(v).trim();
          if (text === "") return f.required ? t("Required.") : null;
          const n = Number(text);
          if (!Number.isFinite(n)) return t("A number.");
          if (shape.kind === K.INT && !Number.isInteger(n)) return t("A whole number.");
          if (n < lo || n > hi) return t("{lo} to {hi}.", { lo, hi });
          return null;
        },
        onCommit: (v) => commit(String(v).trim() === "" ? undefined : Number(v)),
      });
      return;
    }
    if (PLAIN.has(shape.kind)) {
      out.push({ ...base, value: typeof current === "string" ? current : "", kind: "string", onCommit: (v) => commit(String(v) === "" && !f.required ? undefined : String(v)) });
      return;
    }
    const item = shape.of && !Array.isArray(shape.of) ? unwrap(shape.of) : undefined;
    if (shape.kind === K.LIST && item && PLAIN.has(item.kind)) {
      const list = Array.isArray(current) ? current.map(String) : [];
      out.push({
        ...base,
        value: list.join(", "),
        kind: "string",
        description: [f.doc, t("Comma-separated.")].filter(Boolean).join(" "),
        onCommit: (v) => {
          const items = String(v).split(",").map((s) => s.trim()).filter(Boolean);
          commit(items.length === 0 && !f.required ? undefined : items);
        },
      });
      return;
    }
    // Lists of objects, maps, tagged enums, anything: shown, edited as code.
    out.push({ ...base, value: summary(current), readOnly: true, description: [f.doc, t("Edited in the code view.")].filter(Boolean).join(" ") });
  };

  const root = def(desc.root);
  if (root?.kind === K.STRUCT) fields(root.fields, [], general);
  else if (root?.kind === K.ENUM && root.tag) {
    const tag = root.tag;
    const kind = typeof value[tag] === "string" ? (value[tag] as string) : "";
    out.push({
      id: tag,
      name: humanize(tag),
      category: general,
      description: root.doc,
      value: kind,
      kind: "enum",
      options: root.variants.map((v) => v.name),
      // Another kind keeps the fields it shares with this one (`id`…).
      onCommit: (v) => {
        const next: Obj = { [tag]: String(v) };
        const keep = root.variants.find((x) => x.name === String(v))?.fields?.map((f) => f.name) ?? [];
        for (const k of keep) if (value[k] !== undefined) next[k] = value[k];
        set(next);
      },
    });
    const variant = root.variants.find((v) => v.name === kind);
    if (variant?.fields) fields(variant.fields, [], general);
  }
  return out;
}
