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
const previews = new Map<string, string | null>();
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

/** A 32 px preview of `source` as a data URL (`undefined` until loaded, `null` if it can't be drawn). */
export function imagePreview(path: string, source: string): string | null | undefined {
  const key = `${path}\n${source}`;
  if (previews.has(key)) return previews.get(key);
  if (!pending.has(key)) {
    pending.add(key);
    invoke<string | null>("yui_image_preview", { path, source, size: 32 })
      .then((url) => previews.set(key, url))
      .catch(() => previews.set(key, null))
      .finally(() => {
        pending.delete(key);
        changed();
      });
  }
  return undefined;
}

/** Drops cached lists and previews (a texture was added or edited). */
export function refreshImageSources() {
  lists.clear();
  previews.clear();
  changed();
}

/** Raw resource path → the alias to use instead (mirrors `yog_gfx::image::suggest_alias`). */
export function suggestImageAlias(value: string): string | null {
  const m = /^([a-z0-9_.-]+):textures\/(.+?)(\.png)?$/.exec(value.trim());
  if (!m) return null;
  const [, ns, path] = m;
  const short = (id: string) => (ns === "minecraft" ? id : `${ns}:${id}`);
  if (path.startsWith("item/")) return `item:${short(path.slice(5))}`;
  if (path.startsWith("block/")) return `block:${short(path.slice(6))}`;
  return `${ns}:${path}`;
}
