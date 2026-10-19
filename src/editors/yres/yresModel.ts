// The resource editor's model: the set's other files, grid rows, column ids,
// type labels, clipboard cells, colors.

import { NEUTRAL_LOCALE, type ResourceType, type YresEntry } from "../../lang/yres";

/** Another file of the same resource set — the neutral one or a culture variant: a column of texts. */
export interface Sibling {
  /** `null` = the neutral file. */
  locale: string | null;
  path: string;
  /** `null` when it doesn't parse — shown, but not editable here. */
  entries: YresEntry[] | null;
  texts: Map<string, string>;
}

/** One grid row: an entry of this file (or the empty "new row" at the end). */
export interface Row {
  id: string;
  /** Index in this file's entries; -1 for the new row. */
  index: number;
  name: string;
  type: ResourceType;
  value: string | number | boolean;
  comment: string;
  isNew?: boolean;
  /** From the CLI: the generated accessor, what's wrong with the name and the value, a color's ARGB. */
  accessor?: string;
  problem?: string;
  valueProblem?: string;
  argb?: number;
}

export const NEW_ROW_ID = "__new__";
export const CULTURE_COLUMN = "loc:";
export const SHOW_ALL_KEY = "yog.yres.showAllLanguages";

export const TYPE_LABELS: Record<ResourceType, string> = {
  string: "Text",
  image: "Image",
  file: "File",
  sound: "Sound",
  color: "Color",
  number: "Number",
  bool: "Boolean",
};

/** Tab-separated rows for the clipboard; tabs, newlines and backslashes escaped. */
export function escapeCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r?\n/g, "\\n");
}

export function unescapeCell(text: string): string {
  return text.replace(/\\(.)/g, (_, c: string) => (c === "t" ? "\t" : c === "n" ? "\n" : c));
}

export const columnOf = (locale: string | null) => `${CULTURE_COLUMN}${locale ?? ""}`;
export const localeLabel = (locale: string | null) => locale ?? NEUTRAL_LOCALE;
export const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
export const RGB_MASK = 0xffffff;
export const ALPHA_SHIFT = 24;
export const OPAQUE = 0xff;
/** Hex digits of a color's RGB, and of its alpha. */
const RGB_DIGITS = 6;
const ALPHA_DIGITS = 2;
/** `#rrggbb` of an ARGB color (as the CLI reads it) — what `<input type="color">` takes. */
export const rgbOf = (argb: number | undefined) => `#${hex((argb ?? RGB_MASK) & RGB_MASK, RGB_DIGITS)}`;
/** CSS for an ARGB color; none: transparent. */
export function cssColor(argb: number | undefined): string {
  if (argb === undefined) return "transparent";
  return `${rgbOf(argb)}${hex(argb >>> ALPHA_SHIFT, ALPHA_DIGITS)}`;
}
