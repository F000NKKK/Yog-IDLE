// What the `<Image source>` property offers: Yog image sources (`item:apple`,
// `sprite:button`, `mod:gui/logo` — see docs/yui.md) listed and previewed by
// the backend (`yui_image_sources`, `yui_image_preview`), cached here so the
// synchronous Properties rows can show them; listeners re-render when they
// arrive.

import { invoke } from "@tauri-apps/api/core";

export interface ImageSourceCandidate {
  /** What to write in `source`. */
  source: string;
  /** `mod`, `sprite`, `item` or `block`. */
  group: string;
  detail: string;
}

const lists = new Map<string, ImageSourceCandidate[]>();
/** What the backend drew for a reference (`designer::images::preview`): its URL, and the alias for a raw path. */
interface Preview {
  url: string | null;
  alias: string | null;
}
const previews = new Map<string, Preview>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  for (const l of listeners) l();
}

/** For `useSyncExternalStore`: re-renders when a list or a preview arrives. */
export function subscribeImageSources(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function imageSourcesVersion(): number {
  return version;
}

/** The sources offered for the `.yui` at `path` (empty until loaded — then listeners fire). */
export function imageSources(path: string): ImageSourceCandidate[] {
  const hit = lists.get(path);
  if (hit) return hit;
  const key = `list:${path}`;
  if (!pending.has(key)) {
    pending.add(key);
    invoke<ImageSourceCandidate[]>("yui_image_sources", { path })
      .then((list) => lists.set(path, list))
      .catch(() => lists.set(path, []))
      .finally(() => {
        pending.delete(key);
        changed();
      });
  }
  return [];
}

function preview(path: string, source: string): Preview | undefined {
  const key = `${path}\n${source}`;
  if (previews.has(key)) return previews.get(key);
  if (!pending.has(key)) {
    pending.add(key);
    invoke<Preview>("yui_image_preview", { path, source, size: 32 })
      .then((p) => previews.set(key, p))
      .catch(() => previews.set(key, { url: null, alias: null }))
      .finally(() => {
        pending.delete(key);
        changed();
      });
  }
  return undefined;
}

/**
 * A 32 px preview of any image reference — `item:`/`block:`/`sprite:`, a
 * texture id, a raw resource path, `@Set.name` — as a data URL
 * (`undefined` until loaded, `null` if it can't be drawn). The one way the
 * IDE previews an image (re-render on `subscribeImageSources`).
 */
export function imagePreview(path: string, source: string): string | null | undefined {
  const p = preview(path, source);
  return p === undefined ? undefined : p.url;
}

/** For a raw resource path, the alias to write instead (`yog_gfx::image::suggest_alias`, asked with the preview). */
export function imageAlias(path: string, source: string): string | null | undefined {
  return preview(path, source)?.alias;
}

const tags = new Map<string, string[]>();

/**
 * The items of item tag `tag` (`#minecraft:planks`) for the file at
 * `path` — `undefined` until loaded, empty if the tag is unknown.
 */
export function tagItems(path: string, tag: string): string[] | undefined {
  const key = `${path}\n#${tag}`;
  if (tags.has(key)) return tags.get(key);
  if (!pending.has(key)) {
    pending.add(key);
    invoke<string[]>("item_tag_items", { path, tag })
      .then((items) => tags.set(key, items))
      .catch(() => tags.set(key, []))
      .finally(() => {
        pending.delete(key);
        changed();
      });
  }
  return undefined;
}

/**
 * The items an ingredient may be, in order: alternatives (`a|b`), tags
 * (`#c:dusts`) opened into their items — what a slot shows in turn.
 */
export function ingredientItems(path: string, value: string): string[] {
  const out: string[] = [];
  for (const part of value.split("|").map((p) => p.trim()).filter(Boolean)) {
    if (part.startsWith("#")) out.push(...(tagItems(path, part.slice(1)) ?? []));
    else out.push(part);
  }
  return out;
}
