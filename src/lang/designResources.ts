/**
 * A mod's `.yres` resources as the screen designer previews them: a `.yui`
 * attribute `@Strings.title` (or `@<translation key>`) shows the text in the
 * IDE's language — the culture variant matching it, else the neutral file —
 * and `texture="@Icons.logo"` the image's source, as `yog build` would
 * resolve them (see docs/yres.md).
 */
import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { resolvedLocale, type DirEntry } from "substrate-platform-ui";
import type { YuiNode } from "../designer/yui";
import { parseYres, splitYresPath, translationKey, type YresEntry } from "./yres";

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
    entries = await invoke<DirEntry[]>("dir_list", { path: dir });
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
  let modId = "";
  try {
    const toml = await invoke<string>("file_read", { path: `${root}/yog.toml` });
    modId = /^\s*id\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? "";
  } catch {
    // no yog.toml — keys can't be resolved, set references still can
  }
  const files: { path: string; rel: string }[] = [];
  await listYres(`${root}/resources`, "", files);
  const sets = new Map<string, ResourceSet>();
  for (const file of files) {
    let text: string;
    try {
      text = await invoke<string>("file_read", { path: file.path });
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

/** What a text attribute shows in the designer: `@ref` resolved (the key itself if unknown), `@@x` as `@x`. */
export function designText(value: string): string {
  if (!value.startsWith("@")) return value;
  if (value.startsWith("@@")) return value.slice(1);
  return resolveText(value.slice(1)) ?? value.slice(1);
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

/** `root` with its `@` references resolved — what the designer hands to the renderer (which has no resources). */
export function withDesignResources(root: YuiNode): YuiNode {
  if (!loaded) return root;
  const resolve = (node: YuiNode): YuiNode => {
    let attrs = node.attrs;
    for (const name of ["text", "placeholder"]) {
      const v = attrs[name];
      if (v === undefined || !v.startsWith("@") || v.startsWith("@@")) continue;
      const shown = designText(v);
      // The renderer takes a leading `@` as a key again — escape it.
      attrs = { ...attrs, [name]: shown.startsWith("@") ? `@${shown}` : shown };
    }
    if (attrs.texture?.startsWith("@")) attrs = { ...attrs, texture: designImage(attrs.texture) };
    const children = node.children.map(resolve);
    const same = attrs === node.attrs && children.every((c, i) => c === node.children[i]);
    return same ? node : { ...node, attrs, children };
  };
  return resolve(root);
}
