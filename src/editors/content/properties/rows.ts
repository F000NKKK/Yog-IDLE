// The Properties grid's rows for a .yblock/.yitem: numbers, texts, choices,
// flags, vectors and lists, each written back as the file wants it.

import { type PropertyDescriptor, t } from "substrate-platform-ui";
import type { ContentFile } from "../../../content/model";
import { parseVec, vecText } from "../fieldText";

/** Rows of the Properties grid, each a field of the file — read-only with the file. */
export interface PropertyRows extends ReturnType<typeof rowHelpers> {
  /** Whether `o` has nothing set (every value `undefined`). */
  prune: (o: Record<string, unknown> | undefined) => boolean;
  /** The block state properties that are yes/no. */
  yesNoProperties: string[];
}

/** The row helpers, read-only when `ro`. */
function rowHelpers(ro: boolean | undefined) {
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
  return { num, text, choice, flag, vec, list };
}

/** The rows for `file`, read-only when `readOnly`. */
export function propertyRows(file: ContentFile, readOnly: boolean | undefined): PropertyRows {
  return {
    ...rowHelpers(readOnly),
    prune: (o) => !!o && Object.values(o).every((x) => x === undefined),
    yesNoProperties: Object.entries(file.states?.properties ?? {})
      .filter(([, values]) => values.length === 2 && values.includes("true") && values.includes("false"))
      .map(([name]) => name),
  };
}
