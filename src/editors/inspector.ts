// The rows the designers' inspectors are built of (Substrate's PropertyGrid,
// shown in Properties) — one way each kind of value is edited, checked and
// written back, whichever designer shows it: an optional text or number
// (empty: unset), a choice, a yes/no with its default, a reference
// (`@item:…`, validated against what the mod, its declared mods and the
// game have, an item's icon beside it), a `0xRRGGBB` colour.

import type { PropertyDescriptor, useT } from "substrate-platform-ui";
import { iconSource, imagePreview } from "../designer/imageSources";
import { refProblem, refSuggestions, type RefChoices } from "../data/contentRefs";

type T = ReturnType<typeof useT>;
type Extra = Partial<PropertyDescriptor>;

/** `0xRRGGBB` as `#rrggbb`. */
export const colorText = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, "0")}`;

/** `#rrggbb`, `0xRRGGBB` or a plain number as `0xRRGGBB`; `null` if it's none. */
export function parseColor(s: string): number | null {
  const v = s.trim();
  const hex = /^(?:#|0x)([0-9a-f]{6})$/i.exec(v);
  if (hex) return parseInt(hex[1], 16);
  if (/^\d+$/.test(v) && Number(v) <= 0xffffff) return Number(v);
  return null;
}

/** Kinds of reference whose ids draw as an item's icon. */
const ICON_KINDS = new Set(["item", "block"]);

/**
 * The row builders for one inspector: `ro` makes every row read only;
 * `path` is the file shown (references are listed and drawn for it).
 */
export function inspectorRows(t: T, ro: boolean, path: string) {
  const text = (id: string, name: string, category: string, value: string | undefined, set: (v: string | undefined) => void, extra: Extra = {}): PropertyDescriptor => ({
    id,
    name,
    category,
    value: value ?? "",
    kind: "string",
    readOnly: ro,
    onCommit: (v) => set(String(v).trim() === "" ? undefined : String(v).trim()),
    ...extra,
  });

  const num = (
    id: string,
    name: string,
    category: string,
    value: number | undefined,
    set: (v: number | undefined) => void,
    opts: { min?: number; max?: number; int?: boolean } & Extra = {},
  ): PropertyDescriptor => {
    const { min, max, int, ...extra } = opts;
    return {
      id,
      name,
      category,
      value: value ?? "",
      kind: "string",
      readOnly: ro,
      validate: (v) => {
        const s = String(v).trim();
        if (s === "") return null;
        const n = Number(s);
        if (Number.isNaN(n)) return t("Not a valid number.");
        if (int && !Number.isInteger(n)) return t("A whole number.");
        if ((min !== undefined && n < min) || (max !== undefined && n > max)) return t("Between {min} and {max}.", { min: min ?? "-∞", max: max ?? "∞" });
        return null;
      },
      onCommit: (v) => set(String(v).trim() === "" ? undefined : Number(v)),
      ...extra,
    };
  };

  const choice = (id: string, name: string, category: string, value: string | undefined, options: readonly string[], set: (v: string | undefined) => void, extra: Extra = {}): PropertyDescriptor => ({
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

  /** A yes/no: its default is written as unset. */
  const flag = (id: string, name: string, category: string, value: boolean | undefined, def: boolean, set: (v: boolean | undefined) => void, extra: Extra = {}): PropertyDescriptor => ({
    id,
    name,
    category,
    value: value ?? def,
    kind: "bool",
    readOnly: ro,
    onCommit: (v) => set(v === def ? undefined : Boolean(v)),
    ...extra,
  });

  /** A reference of `kind`: picked from what there is, checked, an item's icon shown. */
  const ref = (
    id: string,
    name: string,
    category: string,
    value: string | undefined,
    kind: string,
    choices: RefChoices,
    set: (v: string | undefined) => void,
    opts: { tags?: boolean } & Extra = {},
  ): PropertyDescriptor => {
    const { tags, ...extra } = opts;
    const v = value ?? "";
    const icon = ICON_KINDS.has(kind) && v.startsWith(`@${kind}:`) ? imagePreview(path, iconSource(v.slice(kind.length + 2))) : undefined;
    return text(id, name, category, v, set, {
      suggestions: refSuggestions(choices, kind),
      image: icon ?? undefined,
      validate: (x) => refMessage(t, refProblem(String(x), kind, choices, tags), kind),
      ...extra,
    });
  };

  /** A `0xRRGGBB` colour, edited as `#rrggbb`. */
  const color = (id: string, name: string, category: string, value: number | undefined, set: (v: number | undefined) => void, extra: Extra = {}): PropertyDescriptor => ({
    id,
    name,
    category,
    value: value === undefined ? "" : colorText(value),
    swatch: value === undefined ? undefined : colorText(value),
    kind: "string",
    readOnly: ro,
    validate: (v) => (String(v).trim() === "" || parseColor(String(v)) !== null ? null : t("A colour: #rrggbb.")),
    onCommit: (v) => set(String(v).trim() === "" ? undefined : (parseColor(String(v)) ?? undefined)),
    ...extra,
  });

  /** A list as comma-separated text: empty = unset. */
  const list = (id: string, name: string, category: string, value: readonly string[] | undefined, set: (v: string[] | undefined) => void, extra: Extra = {}): PropertyDescriptor =>
    text(id, name, category, value?.join(", "), (v) => {
      const items = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      set(items.length ? items : undefined);
    }, extra);

  return { text, num, choice, flag, ref, color, list };
}

/** A reference problem in the user's words. */
export function refMessage(t: T, p: ReturnType<typeof refProblem>, kind: string): string | null {
  if (!p) return null;
  if (p.t === "syntax") return t("A reference: @{kind}:namespace:id.", { kind });
  return t("No {kind} {id} in the mod, the mods yog.toml declares or the game.", { kind, id: p.id });
}
