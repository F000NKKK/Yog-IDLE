// Painted textures as the tab's side state, and textures changed on disk picked up.

import { useEffect } from "react";
import { serveMethod } from "../../../data/yogIds.generated";
import type { EditorProps } from "substrate-platform-ui";
import { cli } from "../../../toolchain/cli";
import type { LoadedTexture } from "../contentModel";
import type { ContentModel } from "../useContentModel";
import type { PaintedTextures } from "./usePaintedTextures";

/** Painted textures as the tab's side state, and textures changed on disk picked up. */
export function useTextureSync(props: EditorProps, m: ContentModel, paintedTextures: PaintedTextures) {
  const { path, readOnly } = props;
  const { setSideState, setImages, setSaved, editedRef, setEditedImages, setAnimations } = m;
  const { dirtyKeys, animDirtyKeys, saveState, saveTextures } = paintedTextures;
  const sideDirty = !readOnly && (dirtyKeys.length > 0 || animDirtyKeys.length > 0);
  useEffect(() => setSideState(path, { dirty: sideDirty, save: saveTextures }), [path, sideDirty, saveTextures, setSideState]);
  useEffect(() => () => setSideState(path, null), [path, setSideState]);

  // A texture changed on disk (another editor, git) shows up when the window
  // regains focus — unless it has unsaved paint here.
  useEffect(() => {
    const recheck = () => {
      const { dirtyKeys: keys, images: cur } = saveState.current;
      for (const key of Object.keys(cur)) {
        if (keys.includes(key) || saveState.current.animDirtyKeys.includes(key)) continue;
        cli<LoadedTexture>(serveMethod.CONTENT_TEXTURE, { path, texture: key })
          .then((src) => {
            if (saveState.current.images[key]?.url === src.url) return;
            setImages((m) => ({ ...m, [key]: src }));
            setAnimations({ [key]: null });
            setSaved((s) => {
              const { [key]: _, ...rest } = s;
              return rest;
            });
            if (editedRef.current[key]) setEditedImages({ [key]: null });
          })
          .catch(() => {});
      }
    };
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [path, setEditedImages, setAnimations]);

  return { sideDirty };
}

/** What `useTextureSync` gives. */
export type TextureSync = ReturnType<typeof useTextureSync>;
