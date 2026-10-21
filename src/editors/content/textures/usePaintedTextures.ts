// Painted textures: their pixels, what's unsaved, and saving them.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { serveMethod } from "../../../data/yogIds.generated";
import type { EditorProps } from "substrate-platform-ui";
import { cli } from "../../../cli";
import { sameAnimation, type TextureAnimation } from "../../../content/animation";
import { decodeImage, type PixelImage, sameImage } from "../../../content/paint/pixels";
import { type Edited, namedTextures } from "../contentModel";
import type { ContentModel } from "../useContentModel";

/** Painted textures: their pixels, what's unsaved, and saving them. */
export function usePaintedTextures(props: EditorProps, m: ContentModel) {
  const { path } = props;
  const { file, images, setImages, decoded, setDecoded, edited, saved, setSaved, animEdits } = m;
  // ── Painted textures: pixels, dirty state, Save, external changes ─────────

  const decoding = useRef(new Set<string>());
  useEffect(() => {
    for (const [key, src] of Object.entries(images)) {
      if (!src || decoded[key]?.url === src.url || decoding.current.has(src.url)) continue;
      decoding.current.add(src.url);
      decodeImage(src.url)
        .then((img) => setDecoded((d) => ({ ...d, [key]: { url: src.url, img } })))
        .catch(() => {})
        .finally(() => decoding.current.delete(src.url));
    }
  }, [images, decoded]);

  /** A texture's pixels as shown (painted, else as on disk). */
  const pixelsOf = (key: string | undefined): PixelImage | undefined => (key ? (edited[key]?.img ?? decoded[key]?.img) : undefined);

  const named = useMemo(() => namedTextures(file), [file]);
  /** Painted textures that differ from the file (new ones only while the file still names them). */
  const dirtyKeys = useMemo(
    () =>
      Object.keys(edited).filter((k) => {
        const base = saved[k] ?? decoded[k]?.img;
        return base ? !sameImage(edited[k].img, base) : named.has(k);
      }),
    [edited, saved, decoded, named]
  );

  /** A texture's animation as shown: edited here, else as loaded. */
  const animOf = (key: string | undefined): TextureAnimation | null =>
    key ? (animEdits[key] ? animEdits[key]!.animation : (images[key]?.animation ?? null)) : null;
  /** Animations changed here and not saved. */
  const animDirtyKeys = useMemo(
    () => Object.keys(animEdits).filter((k) => !sameAnimation(animEdits[k]?.animation, images[k]?.animation)),
    [animEdits, images]
  );

  const saveState = useRef({ dirtyKeys, edited, images, animDirtyKeys, animEdits });
  saveState.current = { dirtyKeys, edited, images, animDirtyKeys, animEdits };
  const saveTextures = useCallback(async () => {
    const { dirtyKeys: keys, edited: cur, animDirtyKeys: animKeys, animEdits: anims } = saveState.current;
    const written: Record<string, Edited> = {};
    for (const key of keys) {
      const e = cur[key];
      await cli<string>(serveMethod.CONTENT_SAVE_TEXTURE, { path, texture: key, png: e.url.slice(e.url.indexOf(",") + 1) });
      written[key] = e;
    }
    // The .mcmeta after its png: its frame size is checked against the image.
    for (const key of animKeys) await cli<string>(serveMethod.CONTENT_SAVE_TEXTURE_ANIMATION, { path, texture: key, animation: anims[key]?.animation ?? null });
    setSaved((s) => ({ ...s, ...Object.fromEntries(Object.entries(written).map(([k, e]) => [k, e.img])) }));
    setImages((m) => {
      const next = { ...m };
      for (const [k, e] of Object.entries(written)) next[k] = { url: e.url, animation: m[k]?.animation ?? null, writable: true };
      for (const k of animKeys) if (next[k]) next[k] = { ...next[k]!, animation: anims[k]?.animation ?? null };
      return next;
    });
  }, [path]);

  return { decoding, pixelsOf, named, dirtyKeys, animOf, animDirtyKeys, saveState, saveTextures };
}

/** What `usePaintedTextures` gives. */
export type PaintedTextures = ReturnType<typeof usePaintedTextures>;
