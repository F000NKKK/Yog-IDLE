/**
 * A mod's `.yres` resources as the screen designer previews them: a `.yui`
 * attribute `@Strings.title` (or `@<translation key>`) shows the text in the
 * IDE's language — the culture variant matching it, else the neutral file —
 * and `texture="@Icons.logo"` the image's source, as `yog build` would
 * resolve them (see docs/yres.md).
 */
import { classify, type Typed } from "../data/yogData";
import { useEffect, useSyncExternalStore } from "react";
import { resolvedLocale, type DirEntry } from "substrate-platform-ui";
import type { YuiNode } from "../designer/yui";
import { parseYres, serializeYres, splitYresPath, translationKey, type YresEntry } from "./yres";
import { files, readModId } from "../files";

interface ResourceSet {
  /** The set's folder relative to `resources/`, `/`-separated (`""` = `resources/` itself). */
  relDir: string;
  neutral: YresEntry[];
  /** locale → name → text. */
  cultures: Map<string, Map<string, string>>;
}

interface Loaded {
  root: string;
  modId: string;
  sets: Map<string, ResourceSet>;
}

let loaded: Loaded | null = null;
let loading: string | null = null;
let version = 0;
const subscribers = new Set<() => void>();

function changed() {
  version++;
  subscribers.forEach((fn) => fn());
}

async function listYres(dir: string, rel: string, out: { path: string; rel: string }[]) {
  let entries: DirEntry[];
  try {
    entries = await files.list(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.kind === "dir") await listYres(e.path, rel ? `${rel}/${e.name}` : e.name, out);
    else if (/\.yres$/i.test(e.name)) out.push({ path: e.path, rel });
  }
}

async function load(root: string) {
  loading = root;
  // Without a mod id keys can't be resolved; set references still can.
  const modId = (await readModId(root)) ?? "";
  const found: { path: string; rel: string }[] = [];
  await listYres(`${root}/resources`, "", found);
  const sets = new Map<string, ResourceSet>();
  for (const file of found) {
    let text: string;
    try {
      text = await files.read(file.path);
    } catch {
      continue;
    }
    const parsed = parseYres(text);
    if (!parsed.ok) continue;
    const { set, locale } = splitYresPath(file.path);
    const entry = sets.get(set) ?? { relDir: file.rel, neutral: [], cultures: new Map() };
    if (locale === null) {
      entry.neutral = parsed.entries;
      entry.relDir = file.rel;
    } else {
      const texts = new Map<string, string>();
      for (const e of parsed.entries) if (e.type === "string" && typeof e.value === "string" && e.value !== "") texts.set(e.name, e.value);
      entry.cultures.set(locale, texts);
    }
    sets.set(set, entry);
  }
  if (loading !== root) return;
  loading = null;
  loaded = { root, modId, sets };
  changed();
}

/** Reloads the resources (a `.yres` file was saved). */
export function invalidateDesignResources() {
  if (loaded) void load(loaded.root);
}

/**
 * Loads the resources of the mod at `root` for the designer (again when the
 * window regains focus) and re-renders the caller when they change; returns
 * a version number to key memos on.
 */
export function useDesignResources(root: string | null): number {
  const v = useSyncExternalStore(
    (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    () => version
  );
  useEffect(() => {
    if (!root) return;
    if (loaded?.root !== root && loading !== root) void load(root);
    const onFocus = () => void load(root);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [root]);
  return v;
}

/** The culture of the IDE's language: `ru` / `ru-RU` → `ru_ru` (or the first `ru_*`). */
function cultureFor(cultures: Map<string, Map<string, string>>): Map<string, string> | undefined {
  const ide = resolvedLocale().toLowerCase().replace("-", "_");
  if (cultures.has(ide)) return cultures.get(ide);
  const lang = ide.split("_")[0];
  if (cultures.has(`${lang}_${lang}`)) return cultures.get(`${lang}_${lang}`);
  for (const [locale, texts] of cultures) if (locale.startsWith(`${lang}_`)) return texts;
  return undefined;
}

/** `@Set.name` → the set and entry; `undefined` if it isn't one. */
function lookup(ref: string): { set: ResourceSet; entry: YresEntry } | undefined {
  if (!loaded) return undefined;
  const dot = ref.indexOf(".");
  if (dot > 0) {
    const set = loaded.sets.get(ref.slice(0, dot));
    const entry = set?.neutral.find((e) => e.name === ref.slice(dot + 1));
    if (set && entry) return { set, entry };
  }
  // Any translation key: the text entry that has it.
  for (const [name, set] of loaded.sets) {
    const entry = set.neutral.find((e) => e.type === "string" && translationKey(name, e, loaded!.modId) === ref);
    if (entry) return { set, entry };
  }
  return undefined;
}

/** Shown text of `@ref` (without the `@`), or `undefined` when nothing defines it. */
function resolveText(ref: string): string | undefined {
  const found = lookup(ref);
  if (!found) return undefined;
  if (found.entry.type === "string") return cultureFor(found.set.cultures)?.get(found.entry.name) ?? String(found.entry.value);
  return String(found.entry.value);
}

/**
 * What a text attribute shows in the designer: `@Set.name` its text,
 * `@lang:key` the mod's text with that key (else the key), `@item:id` the
 * id, `@@x` as `@x`.
 */
export function designText(value: string): string {
  if (!value.startsWith("@")) return value;
  let typed: Typed;
  try {
    typed = classify(value);
  } catch {
    return value.slice(1);
  }
  switch (typed.t) {
    case "str":
      return typed.v;
    case "lang":
      return resolveText(typed.key) ?? typed.key;
    case "res":
      return resolveText(`${typed.set}.${typed.key}`) ?? `${typed.set}.${typed.key}`;
    case "ref":
      return typed.id;
    default:
      return value;
  }
}

/** An image attribute: `@Icons.logo` → `<mod id>:<texture>` (as `yog build` bundles it), else as written. */
export function designImage(value: string): string {
  if (!value.startsWith("@") || value.startsWith("@@") || !loaded) return value;
  const found = lookup(value.slice(1));
  if (!found || found.entry.type !== "image" || typeof found.entry.value !== "string") return value;
  const texture =
    found.entry.texture ??
    [found.set.relDir, found.entry.value]
      .filter(Boolean)
      .join("/")
      .replace(/\.png$/i, "");
  return `${loaded.modId}:${texture}`;
}

/** `@Colors.x` → its `#AARRGGBB`/`#RRGGBB` value; anything else as written. */
export function designColor(value: string): string {
  if (!value.startsWith("@") || value.startsWith("@@")) return value;
  const found = lookup(value.slice(1));
  return found?.entry.type === "color" && typeof found.entry.value === "string" ? found.entry.value : value;
}

/** Every color resource of the mod as `@Set.name` — what a color property offers. */
export function colorRefs(): string[] {
  if (!loaded) return [];
  const out: string[] = [];
  for (const [set, rs] of loaded.sets) for (const e of rs.neutral) if (e.type === "color") out.push(`@${set}.${e.name}`);
  return out.sort();
}

/** Attributes holding colors (plain or state-prefixed, `hover:bg`). */
const COLOR_ATTR = /^(?:[a-z]+:)?(?:bg|color|focus_color|tint)$/;

/**
 * Adds `value` to the mod's `resources/Colors.yres` (made if missing) as a
 * new color named after `hint` (`widget_bg`, `widget_bg_2`, ...); returns
 * the reference to use instead, `@Colors.<name>`.
 */
export async function extractColor(root: string, hint: string, value: string): Promise<string> {
  const path = `${root}/resources/Colors.yres`;
  let entries: YresEntry[] = [];
  try {
    const parsed = parseYres(await files.read(path));
    if (parsed.ok) entries = parsed.entries.map(({ line: _, ...e }) => e as YresEntry);
  } catch {
    await files.createFile(path);
  }
  const base = hint.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "color";
  let name = base;
  for (let n = 2; entries.some((e) => e.name === name); n++) name = `${base}_${n}`;
  entries.push({ name, type: "color", value });
  await files.write(path, serializeYres(entries));
  invalidateDesignResources();
  return `@Colors.${name}`;
}

/** `root` with its `@` references resolved — what the designer hands to the renderer (which has no resources). */
export function withDesignResources(root: YuiNode): YuiNode {
  if (!loaded) return root;
  const resolve = (node: YuiNode): YuiNode => {
    let attrs = node.attrs;
    // (`d:` design-time values too: shown in place of a bound one.)
    for (const name of ["text", "placeholder", "d:text", "d:placeholder"]) {
      const v = attrs[name];
      if (v === undefined || !v.startsWith("@") || v.startsWith("@@")) continue;
      const shown = designText(v);
      // The renderer takes a leading `@` as a key again — escape it.
      attrs = { ...attrs, [name]: shown.startsWith("@") ? `@${shown}` : shown };
    }
    if (attrs.source?.startsWith("@")) attrs = { ...attrs, source: designImage(attrs.source) };
    if (attrs["d:source"]?.startsWith("@")) attrs = { ...attrs, "d:source": designImage(attrs["d:source"]) };
    for (const [name, v] of Object.entries(attrs)) {
      if (COLOR_ATTR.test(name) && v.startsWith("@") && !v.startsWith("@@")) attrs = { ...attrs, [name]: designColor(v) };
    }
    const children = node.children.map(resolve);
    const same = attrs === node.attrs && children.every((c, i) => c === node.children[i]);
    return same ? node : { ...node, attrs, children };
  };
  return resolve(root);
}
