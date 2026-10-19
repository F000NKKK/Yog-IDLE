// Painting textures in the view or the 2D canvas, and an item sprite's layers.

import { useEffect, useMemo, useRef } from "react";
import { confirmDialog, documentAction, type EditorProps, notify, reportError, showDialog, stemOf } from "substrate-platform-ui";
import type { PaintHit } from "../../content/Viewport";
import { cropFrame, pasteFrame, type TextureAnimation } from "../../content/animation";
import { clone, type Element } from "../../content/model";
import type { PaintModifiers, PaintPhase } from "../../content/paint/PaintCanvas";
import { blankImage, cloneImage, getPixel, type PixelImage, sameImage, Stroke } from "../../content/paint/pixels";
import { spriteLayerElements } from "../../content/spriteElements";
import { TYPED } from "../../data/yogFormat";
import { kind as KIND, sep } from "../../data/yogIds.generated";
import type { ContentModel } from "./useContentModel";
import type { ContentTextures } from "./useContentTextures";
import { ensureModel, LAYER, layerIndex, type LoadedTexture, stateModelOf } from "./contentModel";

/** Painting textures in the view or the 2D canvas, and an item sprite's layers. */
export function useContentPaint(props: EditorProps, m: ContentModel, tx: ContentTextures) {
  const { path, readOnly } = props;
  const { t, setSelected, face, setFace, images, choices, paintMode, setPaintMode, paint, setPaint, usedColor, paintSlot, setPaintSlot, edited, editedRef, animEdits, animEditsRef, paintEntry, playing, effectiveKey, model, modelKind, resolved, selEl, setEditedImages, update, setAnimations, pixelStep, animationStep } = m;
  const { pixelsOf, named, animOf } = tx;
  // ── Painting ──────────────────────────────────────────────────────────────

  const paintOn = !readOnly && (paintMode || !!resolved.sprite);
  const faceSlot = selEl && face ? selEl.faces[face]?.texture.replace(/^#/, "") : undefined;
  const paintSlots = resolved.slots.filter((s) => resolved.textures[s] && s !== "particle");
  const activeSlot = paintSlot && paintSlots.includes(paintSlot) ? paintSlot : faceSlot && paintSlots.includes(faceSlot) ? faceSlot : (paintSlots[0] ?? null);
  const activeKey = activeSlot ? resolved.textures[activeSlot] : undefined;
  const activeAnim = animOf(activeKey);
  const activeEntry = activeKey && activeAnim ? Math.max(0, Math.min(paintEntry[activeKey] ?? 0, activeAnim.frames.length - 1)) : 0;
  /** The image frame painted: the picked step's (frame 0 — the whole image — when it isn't animated). */
  const activeFrame = activeAnim?.frames[activeEntry]?.index ?? 0;

  /** What the view and the pickers show: painted textures over the loaded ones, the painted frame held while painting. */
  const shownImages = useMemo(() => {
    const out: Record<string, LoadedTexture | undefined> = {};
    for (const k of new Set([...Object.keys(images), ...Object.keys(edited)])) {
      const loaded = images[k];
      const e = edited[k];
      if (!loaded && !e) {
        out[k] = undefined;
        continue;
      }
      const animation = animEdits[k] ? animEdits[k]!.animation : (loaded?.animation ?? null);
      const pinned = paintOn && !playing && k === activeKey && animation ? activeFrame : undefined;
      out[k] = { url: e?.url ?? loaded!.url, animation, writable: e ? true : loaded!.writable, pinned };
    }
    return out;
  }, [images, edited, animEdits, paintOn, playing, activeKey, activeFrame]);
  // The 2D view follows the face picked in the outliner or the view.
  useEffect(() => {
    if (faceSlot) setPaintSlot(faceSlot);
  }, [faceSlot]);

  /** A new texture of the mod for `slot` — `@texture:<mod>:item/<file>`, `…:block/<file>_<slot>` and the like, not yet taken. */
  const newTexturePath = (slot: string): string => {
    const stem = (stemOf(path) || "texture").toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
    const folder = modelKind === "item" || resolved.sprite ? "item" : "block";
    const state = stateModelOf(effectiveKey);
    const several = paintSlots.length > 1 || effectiveKey === "arm" || state !== null;
    const base = `${folder}/${stem}${state !== null ? `_${state}` : ""}${several ? `_${slot}` : ""}`;
    const taken = new Set([...choices.textures, ...Object.keys(editedRef.current), ...named]);
    const ref = (p: string) => `${TYPED}${KIND.TEXTURE}${sep.NAMESPACE}${choices.modId}${sep.NAMESPACE}${p}`;
    let value = ref(base);
    for (let n = 2; taken.has(value); n++) value = ref(`${base}_${n}`);
    return value;
  };

  /** Points `slot` at a new texture `img` (a copy, or a blank one) — one undo step, the file and the texture. */
  const assignTexture = (slot: string, img: PixelImage): string => {
    const key = newTexturePath(slot);
    void documentAction(path, () => {
      const written = update((d) => {
        const m = ensureModel(d, effectiveKey);
        m.textures = { ...(m.textures ?? {}), [slot]: key };
      });
      setEditedImages({ [key]: img });
      pixelStep(key, null, img);
      return written;
    });
    return key;
  };

  /**
   * A stroke being painted: on one frame of an animated texture (`anim`,
   * image frame `frameIndex` of `strip`), else on the whole image.
   */
  const stroke = useRef<{ stroke: Stroke; slot: string; key: string; frame: number; anim: TextureAnimation | null; frameIndex: number; strip: PixelImage } | null>(null);
  /** The texture image with the stroke's pixels in it. */
  const strokeImage = (cur: NonNullable<typeof stroke.current>): PixelImage =>
    cur.anim ? pasteFrame(cur.strip, cur.anim, cur.frameIndex, cur.stroke.image) : cur.stroke.image;

  const beginPaint = (slot: string, x: number, y: number, pick: boolean) => {
    if (!paintOn || stroke.current) return;
    let key = resolved.textures[slot];
    let base = pixelsOf(key);
    if (!key || !base) return;
    // An animated texture is painted a frame at a time: the one picked in
    // the frame strip (for the texture in the 2D view), else the first.
    const anim = animOf(key);
    const frameIndex = anim ? (key === activeKey ? activeFrame : (anim.frames[0]?.index ?? 0)) : 0;
    const frameOf = (img: PixelImage) => (anim ? cropFrame(img, anim, frameIndex) : img);
    if (paint.tool === "picker" || pick) {
      const c = getPixel(frameOf(base), x, y);
      if (c) setPaint({ color: c, ...(paint.tool === "picker" ? { tool: "pencil" as const } : {}) });
      return;
    }
    if (paint.tool === "fill" && !getPixel(frameOf(base), x, y)) return;
    const writable = images[key]?.writable ?? key in editedRef.current;
    if (!writable) {
      // Not the mod's texture (Minecraft's, another mod's): paint a copy in the mod.
      base = cloneImage(base);
      key = assignTexture(slot, base);
      // The copy keeps the animation (written with it on Save).
      if (anim) setAnimations({ [key]: { animation: anim } });
      notify({ level: "info", message: t("Copied into the mod: {path}", { path: `resources/${key}` }) });
    }
    const s = new Stroke(frameOf(base), paint, x, y);
    stroke.current = { stroke: s, slot, key, frame: 0, anim, frameIndex, strip: base };
    setEditedImages({ [key]: strokeImage(stroke.current) });
  };

  const movePaint = (x: number, y: number) => {
    const cur = stroke.current;
    if (!cur) return;
    cur.stroke.move(x, y);
    // At most one redraw a frame.
    if (!cur.frame)
      cur.frame = requestAnimationFrame(() => {
        cur.frame = 0;
        if (stroke.current === cur) setEditedImages({ [cur.key]: strokeImage(cur) });
      });
  };

  const endPaint = () => {
    const cur = stroke.current;
    if (!cur) return;
    stroke.current = null;
    cancelAnimationFrame(cur.frame);
    const painted = strokeImage(cur);
    setEditedImages({ [cur.key]: painted });
    if (!sameImage(cur.stroke.image, cur.stroke.base)) {
      pixelStep(cur.key, cur.strip, painted);
      if (cur.stroke.settings.tool !== "eraser") usedColor(cur.stroke.settings.color);
    }
  };

  /** Changes texture `key`'s animation (and its image, when frames were added) — one undo step. */
  const editAnimation = (key: string, animation: TextureAnimation, img?: PixelImage) =>
    documentAction(path, () => {
      if (img) {
        pixelStep(key, editedRef.current[key]?.img ?? null, img);
        setEditedImages({ [key]: img });
      }
      animationStep(key, animEditsRef.current[key] ?? null, { animation });
      setAnimations({ [key]: { animation } });
    });

  const onCanvasPaint = (x: number, y: number, phase: PaintPhase, mods: PaintModifiers) => {
    if (phase === "down") activeSlot && beginPaint(activeSlot, x, y, mods.alt);
    else if (phase === "move") movePaint(x, y);
    else endPaint();
  };

  const onViewportPaint = (hit: PaintHit | null, phase: "down" | "move" | "up", alt: boolean) => {
    if (phase === "down") {
      if (!hit) return;
      if (hit.element !== null) {
        setSelected(hit.element);
        setFace(hit.face);
      }
      setPaintSlot(hit.slot);
      beginPaint(hit.slot, hit.x, hit.y, alt);
    } else if (phase === "move") {
      if (hit && hit.slot === stroke.current?.slot) movePaint(hit.x, hit.y);
    } else endPaint();
  };

  const newTexture = async () => {
    const slot = activeSlot ?? (resolved.sprite ? "layer0" : resolved.slots[0]);
    if (!slot) return;
    const r = await showDialog({
      title: t("New Texture"),
      message: t("A blank texture for the {slot} slot, saved in the mod's resources/ with the file.", { slot }),
      buttons: [
        { id: "cancel", label: t("Cancel") },
        { id: "16", label: "16×16", variant: "primary" },
        { id: "32", label: "32×32" },
        { id: "64", label: "64×64" },
      ],
    });
    const n = Number(r.button);
    if (!n) return;
    assignTexture(slot, blankImage(n, n));
    setPaintSlot(slot);
  };

  // ── Sprite layers ─────────────────────────────────────────────────────────

  const layers = useMemo(
    () => resolved.slots.filter((s) => LAYER.test(s)).sort((a, b) => layerIndex(a) - layerIndex(b)),
    [resolved.slots]
  );

  /** Rewrites the layers as `values` (`layer0`, `layer1`, … in order). */
  const setLayers = (values: string[]) =>
    update((d) => {
      const m = ensureModel(d, effectiveKey);
      const tex = Object.fromEntries(Object.entries(m.textures ?? {}).filter(([k]) => !LAYER.test(k)));
      values.forEach((v, i) => (tex[`layer${i}`] = v));
      m.textures = tex;
    });
  const layerValues = () => layers.map((s) => model?.textures?.[s] ?? resolved.textures[s] ?? "");

  const addLayer = () => {
    const first = pixelsOf(resolved.textures.layer0);
    const slot = `layer${layers.length}`;
    assignTexture(slot, blankImage(first?.w ?? 16, first?.h ?? 16));
    setPaintSlot(slot);
  };
  const removeLayer = (slot: string) => {
    setLayers(layerValues().filter((_, i) => layers[i] !== slot));
    setPaintSlot("layer0");
  };
  const moveLayer = (slot: string, by: -1 | 1) => {
    const i = layers.indexOf(slot);
    const values = layerValues();
    if (i + by < 0 || i + by >= values.length) return;
    [values[i], values[i + by]] = [values[i + by], values[i]];
    setLayers(values);
    setPaintSlot(`layer${i + by}`);
  };

  /** The sprite as elements of the model's own (one per rectangle of opaque pixels). */
  const convertToElements = async () => {
    const sprite = resolved.sprite;
    if (!sprite) return;
    const els: Element[] = [];
    for (const [i, { slot, texture }] of sprite.entries()) {
      const img = pixelsOf(texture);
      if (!img) {
        reportError(t("The texture {texture} isn't loaded.", { texture }));
        return;
      }
      // An animated sprite's shape is its first frame's.
      const anim = animOf(texture);
      els.push(...spriteLayerElements(anim ? cropFrame(img, anim, anim.frames[0]?.index ?? 0) : img, slot, i));
    }
    if (
      els.length > 256 &&
      !(await confirmDialog({
        title: t("Convert to 3D Elements"),
        message: t("This makes {n} elements — a lot for one model. Convert anyway?", { n: els.length }),
        confirmLabel: t("Convert"),
      }))
    )
      return;
    update((d) => {
      const m = ensureModel(d, effectiveKey);
      m.textures = { ...Object.fromEntries(sprite.map((l) => [l.slot, l.texture])), ...(m.textures ?? {}) };
      delete m.parent;
      m.elements = els;
      m.display = clone(resolved.display);
      m.gui_light = "front";
    });
    setPaintMode(true);
    setSelected(null);
    setFace(null);
  };

  return { paintOn, faceSlot, paintSlots, activeSlot, activeKey, activeAnim, activeEntry, activeFrame, shownImages, newTexturePath, assignTexture, stroke, strokeImage, beginPaint, movePaint, endPaint, editAnimation, onCanvasPaint, onViewportPaint, newTexture, layers, setLayers, layerValues, addLayer, removeLayer, moveLayer, convertToElements };
}

/** What `useContentPaint` gives the editor. */
export type ContentPaint = ReturnType<typeof useContentPaint>;
