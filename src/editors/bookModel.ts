// `.ybook` ⇄ what the book designer edits: the book (yog-book's `Book` as
// JSON), its categories, entries and their pages. Fields the designer
// doesn't know stay as they are; texts may be `@Set.key`, `@item:id` or
// `@block:id` references (docs/books.md).

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Obj = { [k: string]: Json };

export interface Book extends Obj {
  id: string;
  name: string;
  categories: Category[];
  entries: Entry[];
}

export interface Category extends Obj {
  id: string;
  name: string;
}

export interface Entry extends Obj {
  id: string;
  name: string;
  category: string;
  pages: Page[];
}

export interface Page extends Obj {
  type: string;
}

/** What the designer shows of one field. */
export interface Field {
  key: string;
  label: string;
  kind: "text" | "multiline" | "number" | "bool" | "item" | "entity" | "image" | "color" | "list" | "font";
}

/** Every page type, with its fields. */
export const PAGE_TYPES: { type: string; label: string; fields: Field[] }[] = [
  { type: "text", label: "Text", fields: [{ key: "title", label: "Title", kind: "text" }, { key: "text", label: "Text", kind: "multiline" }] },
  {
    type: "spotlight",
    label: "Spotlight",
    fields: [
      { key: "item", label: "Item", kind: "item" },
      { key: "title", label: "Title", kind: "text" },
      { key: "text", label: "Text", kind: "multiline" },
    ],
  },
  { type: "crafting", label: "Crafting", fields: [{ key: "recipe", label: "Recipe", kind: "text" }, { key: "text", label: "Text", kind: "multiline" }] },
  { type: "smelting", label: "Smelting", fields: [{ key: "recipe", label: "Recipe", kind: "text" }, { key: "text", label: "Text", kind: "multiline" }] },
  {
    type: "image",
    label: "Image",
    fields: [
      { key: "texture", label: "Image", kind: "image" },
      { key: "title", label: "Title", kind: "text" },
      { key: "text", label: "Text", kind: "multiline" },
      { key: "border", label: "Border", kind: "bool" },
    ],
  },
  {
    type: "entity",
    label: "Entity",
    fields: [
      { key: "entity", label: "Entity", kind: "entity" },
      { key: "name", label: "Name", kind: "text" },
      { key: "text", label: "Text", kind: "multiline" },
    ],
  },
  {
    type: "svg",
    label: "SVG",
    fields: [
      { key: "data", label: "SVG", kind: "multiline" },
      { key: "title", label: "Title", kind: "text" },
      { key: "text", label: "Text", kind: "multiline" },
    ],
  },
  {
    type: "custom_text",
    label: "Text in a font",
    fields: [
      { key: "text", label: "Text", kind: "multiline" },
      { key: "font_id", label: "Font", kind: "font" },
      { key: "size_px", label: "Size", kind: "number" },
      { key: "color", label: "Color", kind: "color" },
    ],
  },
  { type: "relations", label: "Related entries", fields: [{ key: "entries", label: "Entries", kind: "list" }, { key: "text", label: "Text", kind: "multiline" }] },
  { type: "empty", label: "Empty", fields: [] },
];

export const BOOK_FIELDS: Field[] = [
  { key: "name", label: "Name", kind: "text" },
  { key: "author", label: "Author", kind: "text" },
  { key: "landing_text", label: "Landing text", kind: "multiline" },
  { key: "nameplate_color", label: "Nameplate color", kind: "text" },
];

export const CATEGORY_FIELDS: Field[] = [
  { key: "name", label: "Name", kind: "text" },
  { key: "description", label: "Description", kind: "multiline" },
  { key: "icon", label: "Icon", kind: "item" },
  { key: "sortnum", label: "Order", kind: "number" },
];

export const ENTRY_FIELDS: Field[] = [
  { key: "name", label: "Name", kind: "text" },
  { key: "icon", label: "Icon", kind: "item" },
  { key: "priority", label: "Order", kind: "number" },
  { key: "read_by_default", label: "Read from the start", kind: "bool" },
  { key: "secret", label: "Hidden", kind: "bool" },
  { key: "advancement", label: "Unlocked by advancement", kind: "text" },
];

export function pageFields(type: string): Field[] {
  return PAGE_TYPES.find((p) => p.type === type)?.fields ?? [];
}

/** A new page of `type`. */
export function newPage(type: string): Page {
  switch (type) {
    case "text":
      return { type, text: "" };
    case "spotlight":
      return { type, item: "minecraft:book" };
    case "crafting":
    case "smelting":
      return { type, recipe: "" };
    case "image":
      return { type, texture: "" };
    case "entity":
      return { type, entity: "minecraft:pig" };
    case "svg":
      return { type, data: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>' };
    case "custom_text":
      return { type, text: "", font_id: "minecraft:default", size_px: 9, color: 0xff000000 };
    case "relations":
      return { type, entries: [] };
    default:
      return { type };
  }
}

/** The `.ybook` text → the book; `null` when it isn't one. */
export function parseBook(text: string): Book | null {
  if (text.trim() === "") return emptyBook("");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const b = v as Obj;
  const arr = (x: Json | undefined) => (Array.isArray(x) ? x : []);
  return {
    ...b,
    id: typeof b.id === "string" ? b.id : "",
    name: typeof b.name === "string" ? b.name : "",
    categories: arr(b.categories).filter(isObj) as Category[],
    entries: (arr(b.entries).filter(isObj) as Entry[]).map((e) => ({ ...e, pages: (arr(e.pages).filter(isObj) as Page[]) })),
  };
}

function isObj(v: Json): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function emptyBook(id: string): Book {
  return { id, name: "", categories: [], entries: [] };
}

export function serializeBook(b: Book): string {
  return JSON.stringify(b, null, 2) + "\n";
}

/** An id not yet in `taken`: `base`, `base_2`, … */
export function freshId(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}_${n}`)) return `${base}_${n}`;
}

/** `list` with the item at `from` moved by `by` (clamped). */
export function moved<T>(list: T[], from: number, by: number): T[] {
  const to = Math.max(0, Math.min(list.length - 1, from + by));
  if (to === from) return list;
  const out = [...list];
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it);
  return out;
}

/** Sets `key` of `o` to `value`; an empty value removes an optional field. */
export function withField(o: Obj, key: string, value: Json | undefined): Obj {
  const out = { ...o };
  if (value === undefined || value === "") delete out[key];
  else out[key] = value;
  return out;
}

/** The entries of category `id`, in the order the book lists them. */
export function entriesOf(b: Book, category: string): { entry: Entry; index: number }[] {
  return b.entries
    .map((entry, index) => ({ entry, index }))
    .filter((e) => e.entry.category === category)
    .sort((a, b) => num(a.entry.priority) - num(b.entry.priority));
}

function num(v: Json | undefined): number {
  return typeof v === "number" ? v : 0;
}
