// The pickers' choices, the parent models, and the textures the model uses, loaded.

import { useEffect, useMemo, useRef } from "react";
import { type EditorProps, reportError } from "substrate-platform-ui";
import { cli } from "../../../toolchain/cli";
import { kindOf, templateOf } from "../../../content/model";
import { GAME_NAMESPACE } from "../../../data/yogFormat";
import { kind as KIND, serveMethod } from "../../../data/yogIds.generated";
import { allModels, type LoadedTexture, type ParentModel } from "../contentModel";
import type { ContentModel } from "../useContentModel";

/** The pickers' choices, the parent models, and the textures the model uses, loaded. */
export function useTextureLoading(props: EditorProps, m: ContentModel) {
  const { path, contentVersion } = props;
  const { t, file, images, setImages, parents, setParents, setChoices, resolved, mainResolved } = m;
  // ── Pickers' choices, parent models, textures ─────────────────────────────

  useEffect(() => {
    let live = true;
    void Promise.all([
      cli<{ value: string }[]>(serveMethod.CONTENT_TEXTURES, { path }).catch(() => []),
      cli<string[]>(serveMethod.CONTENT_STRINGS, { path }).catch(() => []),
      cli<string[]>(serveMethod.CONTENT_SOUND_GROUPS, { path }).catch(() => []),
      cli<string[]>(serveMethod.CONTENT_TAGS, { path, registry: kindOf(path) ?? KIND.ITEM }).catch(() => []),
      cli<string[]>(serveMethod.CONTENT_TOOL_MATERIALS, { path }).catch(() => []),
      cli<string[]>(serveMethod.CONTENT_ARMOR_MATERIALS, { path }).catch(() => []),
      cli<string | null>(serveMethod.CONTENT_MOD_ID, { path }).catch(() => null),
    ]).then(
      ([tex, strings, sounds, tags, toolMaterials, armorMaterials, modId]) =>
        live && setChoices({ modId: modId ?? GAME_NAMESPACE, textures: tex.map((c) => c.value), strings, sounds, tags, toolMaterials, armorMaterials })
    );
    return () => {
      live = false;
    };
  }, [path, contentVersion]);

  const rawParents = useMemo(() => {
    const ids = new Set<string>();
    for (const m of allModels(file)) if (m?.parent && !templateOf(m.parent)) ids.add(m.parent);
    return [...ids];
  }, [file]);
  useEffect(() => {
    for (const id of rawParents) {
      if (id in parents) continue;
      setParents((p) => ({ ...p, [id]: null }));
      cli<ParentModel>(serveMethod.CONTENT_PARENT_MODEL, { path, id })
        .then((m) => setParents((p) => ({ ...p, [id]: m })))
        .catch((e) => reportError(t("Can't load the parent model {id}: {error}", { id, error: String(e) })));
    }
  }, [rawParents, parents, path, t]);

  const wanted = useMemo(() => {
    const v = new Set<string>();
    for (const r of [resolved, mainResolved]) {
      for (const x of Object.values(r.textures)) v.add(x);
      for (const x of r.sprite ?? []) v.add(x.texture);
    }
    return [...v];
  }, [resolved, mainResolved]);
  const requested = useRef(new Set<string>());
  useEffect(() => {
    requested.current = new Set();
  }, [contentVersion]);
  useEffect(() => {
    for (const value of wanted) {
      if (requested.current.has(value)) continue;
      requested.current.add(value);
      cli<LoadedTexture>(serveMethod.CONTENT_TEXTURE, { path, texture: value })
        .then((src) => setImages((m) => ({ ...m, [value]: src })))
        .catch(() => setImages((m) => ({ ...m, [value]: undefined })));
    }
  }, [wanted, path, images]);

  return { rawParents, wanted, requested };
}

/** What `useTextureLoading` gives. */
export type TextureLoading = ReturnType<typeof useTextureLoading>;
