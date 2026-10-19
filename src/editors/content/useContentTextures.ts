// The pickers' choices, parent models and textures: loading, painting state, saving; what the view draws.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { type EditorProps, reportError } from "substrate-platform-ui";
import { cli } from "../../cli";
import type { Part } from "../../content/Viewport";
import { sameAnimation, type TextureAnimation } from "../../content/animation";
import { type Dir, kindOf, templateOf, type Vec3 } from "../../content/model";
import { decodeImage, type PixelImage, sameImage } from "../../content/paint/pixels";
import { GAME_NAMESPACE } from "../../data/yogFormat";
import type { ContentModel } from "./useContentModel";
import { allModels, type Edited, type LoadedTexture, MODEL, namedTextures, type ParentModel, stateModelOf } from "./contentModel";

/** The pickers' choices, parent models and textures: loading, painting state, saving; what the view draws. */
export function useContentTextures(props: EditorProps, m: ContentModel) {
  const { path, readOnly, contentVersion } = props;
  const { t, setSideState, file, setSelected, setFace, displaySlot, variant, setStateSel, images, setImages, parents, setParents, setChoices, decoded, setDecoded, edited, saved, setSaved, editedRef, animEdits, effectiveKey, resolved, mainResolved, previewTints, shownVariant, setEditedImages, setAnimations, editElements } = m;
  // ── Pickers' choices, parent models, textures ─────────────────────────────

  useEffect(() => {
    let live = true;
    void Promise.all([
      cli<{ value: string }[]>("content_textures", { path }).catch(() => []),
      cli<string[]>("content_strings", { path }).catch(() => []),
      cli<string[]>("content_sound_groups", { path }).catch(() => []),
      cli<string[]>("content_tags", { path, registry: kindOf(path) ?? "item" }).catch(() => []),
      cli<string[]>("content_tool_materials", { path }).catch(() => []),
      cli<string[]>("content_armor_materials", { path }).catch(() => []),
      cli<string | null>("content_mod_id", { path }).catch(() => null),
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
      cli<ParentModel>("content_parent_model", { path, id })
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
      cli<LoadedTexture>("content_texture", { path, texture: value })
        .then((src) => setImages((m) => ({ ...m, [value]: src })))
        .catch(() => setImages((m) => ({ ...m, [value]: undefined })));
    }
  }, [wanted, path, images]);

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
      await cli<string>("content_save_texture", { path, texture: key, png: e.url.slice(e.url.indexOf(",") + 1) });
      written[key] = e;
    }
    // The .mcmeta after its png: its frame size is checked against the image.
    for (const key of animKeys) await cli<string>("content_save_texture_animation", { path, texture: key, animation: anims[key]?.animation ?? null });
    setSaved((s) => ({ ...s, ...Object.fromEntries(Object.entries(written).map(([k, e]) => [k, e.img])) }));
    setImages((m) => {
      const next = { ...m };
      for (const [k, e] of Object.entries(written)) next[k] = { url: e.url, animation: m[k]?.animation ?? null, writable: true };
      for (const k of animKeys) if (next[k]) next[k] = { ...next[k]!, animation: anims[k]?.animation ?? null };
      return next;
    });
  }, [path]);
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
        cli<LoadedTexture>("content_texture", { path, texture: key })
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

  // ── What the view draws ───────────────────────────────────────────────────

  const rotations = file.states?.rotations ?? [];
  const turnsWithState = effectiveKey === MODEL.main || stateModelOf(effectiveKey) !== null;
  const rot = shownVariant && turnsWithState ? shownVariant : effectiveKey === MODEL.main ? rotations[variant] : undefined;
  const parts = useMemo<Part[]>(() => {
    const own: Part = {
      elements: resolved.elements,
      textures: resolved.textures,
      sprite: resolved.sprite,
      tints: previewTints,
      editable: true,
      x: rot?.x,
      y: rot?.y,
    };
    if (effectiveKey !== MODEL.arm) return [own];
    return [{ elements: mainResolved.elements, textures: mainResolved.textures, sprite: mainResolved.sprite, ghost: true }, own];
  }, [resolved, mainResolved, effectiveKey, rot, previewTints]);

  const display = useMemo(() => {
    if (!displaySlot) return null;
    return { slot: displaySlot, transform: resolved.display[displaySlot] ?? {} };
  }, [displaySlot, resolved]);

  const onSelect = useCallback((el: number | null, f: Dir | null) => {
    setSelected(el);
    setFace(f);
    if (el !== null) setStateSel(null);
  }, []);

  const onTransform = useCallback(
    (index: number, from: Vec3, to: Vec3) =>
      editElements((els) => {
        els[index].from = from;
        els[index].to = to;
      }),
    [editElements]
  );

  return { rawParents, wanted, requested, decoding, pixelsOf, named, dirtyKeys, animOf, animDirtyKeys, saveState, saveTextures, sideDirty, rotations, turnsWithState, rot, parts, display, onSelect, onTransform };
}

/** What `useContentTextures` gives the editor. */
export type ContentTextures = ReturnType<typeof useContentTextures>;
