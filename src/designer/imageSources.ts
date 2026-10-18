import { TAG_MARK, alternativesOf, isTag } from "../data/ingredients";
import { cli } from "../cli";
// What the `<Image source>` property offers: Yog image sources (`item:apple`,
// `sprite:button`, `mod:gui/logo` — see docs/yui.md) listed and previewed by
// the backend (`yui_image_sources`, `yui_image_preview`), cached here so the
// synchronous Properties rows can show them; listeners re-render when they
// arrive.


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
    cli<ImageSourceCandidate[]>("yui_image_sources", { path })
      .then((list) => lists.set(path, list))
      .catch(() => {
        lists.set(path, []);
        retryLater(lists, path);
      })
      .finally(() => {
        pending.delete(key);
        changed();
      });
  }
  return [];
}

/**
 * A failed answer is shown (as nothing) this long, then asked again — the
 * CLI may have been restarting or updating, not unable to draw it.
 */
const RETRY_MS = 2000;

/** Forgets `key` of `cache` after a while, so it's asked again. */
function retryLater(cache: Map<string, unknown>, key: string) {
  window.setTimeout(() => {
    cache.delete(key);
    changed();
  }, RETRY_MS);
}

/** The square previews' side, pixels. */
const PREVIEW_SIZE = 32;

function preview(path: string, source: string, size = PREVIEW_SIZE): Preview | undefined {
  const key = `${path}\n${source}\n${size}`;
  if (previews.has(key)) return previews.get(key);
  if (!pending.has(key)) {
    pending.add(key);
    cli<Preview>("yui_image_preview", { path, source, size })
      .then((p) => previews.set(key, p))
      .catch(() => {
        previews.set(key, { url: null, alias: null });
        retryLater(previews, key);
      })
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

/**
 * The image source for an icon named `id` — the one rule every editor uses:
 * an image reference stays as it is (`item:…`, `block:…`, `sprite:…`,
 * `@Set.name`, a texture path or `ns:textures/….png`); anything else is an
 * item, drawn as its icon (`item:<id>`).
 */
export function iconSource(id: string): string {
  const v = id.trim();
  if (/^(item|block|sprite|mod):/.test(v) || v.startsWith("@") || v.endsWith(".png") || /^[a-z0-9_.-]+:textures\//.test(v)) return v;
  return `item:${v}`;
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
    cli<string[]>("item_tag_items", { path, tag })
      .then((items) => tags.set(key, items))
      .catch(() => {
        tags.set(key, []);
        retryLater(tags, key);
      })
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
  for (const part of alternativesOf(value)) {
    if (isTag(part)) out.push(...(tagItems(path, part.slice(TAG_MARK.length)) ?? []));
    else out.push(part);
  }
  return out;
}
