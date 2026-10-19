// The pickers' choices, parent models and textures: loading, painting state, saving; what the view draws.

import { type EditorProps } from "substrate-platform-ui";
import type { ContentModel } from "./useContentModel";
import { useTextureLoading } from "./textures/useTextureLoading";
import { usePaintedTextures } from "./textures/usePaintedTextures";
import { useTextureSync } from "./textures/useTextureSync";
import { useViewParts } from "./textures/useViewParts";

/** The pickers' choices, parent models and textures: loading, painting state, saving; what the view draws. */
export function useContentTextures(props: EditorProps, m: ContentModel) {
  const textureLoading = useTextureLoading(props, m);
  const paintedTextures = usePaintedTextures(props, m);
  const textureSync = useTextureSync(props, m, paintedTextures);
  const viewParts = useViewParts(m);
  const { rawParents, wanted, requested } = textureLoading;
  const { decoding, pixelsOf, named, dirtyKeys, animOf, animDirtyKeys, saveState, saveTextures } = paintedTextures;
  const { sideDirty } = textureSync;
  const { rotations, turnsWithState, rot, parts, display, onSelect, onTransform } = viewParts;
  return { rawParents, wanted, requested, decoding, pixelsOf, named, dirtyKeys, animOf, animDirtyKeys, saveState, saveTextures, sideDirty, rotations, turnsWithState, rot, parts, display, onSelect, onTransform };
}

/** What `useContentTextures` gives the editor. */
export type ContentTextures = ReturnType<typeof useContentTextures>;
