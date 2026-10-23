// `.ybook` ⇄ what the book designer edits: the book (yog-book's `Book` as
// JSON), its categories, entries and their pages. Fields the designer
// doesn't know stay as they are. What a book names it names by reference
// (`@item:minecraft:stick`, `@category:mymod:basics`…); texts may be
// `@Set.key`, `@item:id` (a name) too (docs/books.md).

import type { DataFormat } from "../../data/useDataFile";
import { readObject } from "../../data/yogData";
import { reference } from "../../data/yogIds.generated";

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
  /** The group Properties lists it under — default "Content". */
  group?: "Text" | "Appearance" | "Order and visibility";
}

/** Every page type, with its fields. */
export const PAGE_TYPES: { type: string; label: string; fields: Field[] }[] = [
  {
    type: "text",
    label: "Text",
    fields: [
      { key: "title", label: "Title", kind: "text", group: "Text" },
      { key: "text", label: "Text", kind: "multiline", group: "Text" },
      { key: "font", label: "Font", kind: "font", group: "Appearance" },
      { key: "font_size", label: "Size", kind: "number", group: "Appearance" },
    ],
  },
  {
    type: "spotlight",
    label: "Spotlight",
    fields: [
      { key: "item", label: "Item", kind: "item" },
      { key: "title", label: "Title", kind: "text", group: "Text" },
      { key: "text", label: "Text", kind: "multiline", group: "Text" },
    ],
  },
  { type: "recipe", label: "Recipe", fields: [{ key: "recipe", label: "Recipe", kind: "text" }, { key: "text", label: "Text", kind: "multiline", group: "Text" }] },
  {
    type: "image",
    label: "Image",
    fields: [
      { key: "texture", label: "Image", kind: "image" },
      { key: "title", label: "Title", kind: "text", group: "Text" },
      { key: "text", label: "Text", kind: "multiline", group: "Text" },
    ],
  },
  {
    type: "entity",
    label: "Entity",
    fields: [
      { key: "entity", label: "Entity", kind: "entity" },
      { key: "name", label: "Name", kind: "text", group: "Text" },
      { key: "text", label: "Text", kind: "multiline", group: "Text" },
    ],
  },
  {
    type: "multiblock",
    label: "Multiblock",
    fields: [
      { key: "name", label: "Name", kind: "text", group: "Text" },
      { key: "text", label: "Text", kind: "multiline", group: "Text" },
    ],
  },
  // A picture the mod's code draws (its `data` is edited in the code view).
  {
    type: "drawn",
    label: "Drawn by the mod",
    fields: [
      { key: "drawer", label: "Drawer", kind: "text" },
      { key: "title", label: "Title", kind: "text", group: "Text" },
      { key: "height", label: "Picture height", kind: "number", group: "Appearance" },
      { key: "caption", label: "Caption", kind: "text", group: "Text" },
      { key: "text", label: "Text", kind: "multiline", group: "Text" },
    ],
  },
  { type: "relations", label: "Related entries", fields: [{ key: "entries", label: "Entries", kind: "list" }, { key: "text", label: "Text", kind: "multiline", group: "Text" }] },
  { type: "empty", label: "Empty", fields: [] },
];

export const BOOK_FIELDS: Field[] = [
  { key: "name", label: "Name", kind: "text", group: "Text" },
  { key: "subtitle", label: "Subtitle", kind: "text", group: "Text" },
  { key: "version", label: "Edition", kind: "number", group: "Order and visibility" },
  { key: "landing_text", label: "Landing text", kind: "multiline", group: "Text" },
  { key: "nameplate_color", label: "Nameplate color", kind: "color", group: "Appearance" },
  { key: "accent", label: "Accent color", kind: "color", group: "Appearance" },
  { key: "book_texture", label: "Book texture", kind: "image", group: "Appearance" },
];

export const CATEGORY_FIELDS: Field[] = [
  { key: "name", label: "Name", kind: "text", group: "Text" },
  { key: "description", label: "Description", kind: "multiline", group: "Text" },
  { key: "icon", label: "Icon", kind: "item" },
  { key: "sortnum", label: "Order", kind: "number", group: "Order and visibility" },
];

export const ENTRY_FIELDS: Field[] = [
  { key: "name", label: "Name", kind: "text", group: "Text" },
  { key: "icon", label: "Icon", kind: "item" },
  { key: "priority", label: "Order", kind: "number", group: "Order and visibility" },
  { key: "read_by_default", label: "Read from the start", kind: "bool", group: "Order and visibility" },
  { key: "secret", label: "Hidden", kind: "bool", group: "Order and visibility" },
  { key: "advancement", label: "Unlocked by advancement", kind: "text", group: "Order and visibility" },
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
      return { type, item: "@item:minecraft:book" };
    case "recipe":
      return { type, recipe: "@recipe:" };
    case "image":
      return { type, texture: "" };
    case "entity":
      return { type, entity: "@entity:minecraft:pig" };
    case "relations":
      return { type, entries: [] };
    case "multiblock":
      return { type, pattern: [["S"]], mapping: { S: "@block:minecraft:stone" } };
    case "drawn":
      return { type, drawer: "", height: 64 };
    default:
      return { type };
  }
}

/** The `.ybook` text → the book; `null` when it isn't one. */
export async function readBook(text: string): Promise<Book | null> {
  if (text.trim() === "") return emptyBook("");
  const r = await readObject<Obj>(text);
  if (!r.ok) return null;
  const b = r.value;
  const arr = (x: Json | undefined) => (Array.isArray(x) ? x : []);
  return {
    ...b,
    id: typeof b.id === "string" ? b.id : "",
    name: typeof b.name === "string" ? b.name : "",
    categories: arr(b.categories).filter(isObj) as Category[],
    entries: (arr(b.entries).filter(isObj) as Entry[]).map((e) => ({ ...e, pages: (arr(e.pages).filter(isObj) as Page[]) })),
  };
}

/** A `.ybook` read and written through the CLI. */
export const BOOK_FORMAT: DataFormat<Book> = {
  read: async (text) => {
    const b = await readBook(text);
    return b ? { ok: true, value: b } : { ok: false, error: "not a book" };
  },
};

function isObj(v: Json): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function emptyBook(id: string): Book {
  return { id, name: "", categories: [], entries: [] };
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

/** `@item:minecraft:stick` → `minecraft:stick`; anything else as it is. */
export function refId(v: string): string {
  const m = /^@(?:item|block|entity|recipe|entry|category):(.+)$/.exec(v.trim());
  return m ? m[1].split("[")[0] : v;
}

/** The reference an entry names its category `id` by. */
export function categoryRef(id: string): string {
  return `${reference.CATEGORY}${id}`;
}

/** The entries of category `id`, in the order the book lists them. */
export function entriesOf(b: Book, category: string): { entry: Entry; index: number }[] {
  return b.entries
    .map((entry, index) => ({ entry, index }))
    .filter((e) => refId(e.entry.category) === category)
    .sort((a, b) => num(a.entry.priority) - num(b.entry.priority));
}

function num(v: Json | undefined): number {
  return typeof v === "number" ? v : 0;
}
