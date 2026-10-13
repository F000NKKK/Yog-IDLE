import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Button,
  confirmDialog,
  Icon,
  IconButton,
  notify,
  notifyDocumentCommands,
  PropertyGrid,
  promptDialog,
  registerDocumentCommands,
  SelectField,
  showDialog,
  useKeybinding,
  useT,
  type EditorProps,
  type PropertyDescriptor,
} from "substrate-platform-ui";
import { useOpenFiles } from "../OpenFilesContext";
import { reportError } from "../reportError";
import {
  ANGLES,
  autoUv,
  clone,
  defaultDisplay,
  DIRS,
  DISPLAY_SLOTS,
  kindOf,
  parseContent,
  RENDER_LAYERS,
  serializeContent,
  SOUNDS,
  templateElements,
  templateOf,
  TEMPLATES,
  TOOL_LEVELS,
  TOOLS,
  type Axis,
  type ContentFile,
  type Dir,
  type DisplaySlot,
  type DisplayTransform,
  type Element,
  type Model,
  type StateRotation,
  type Uv,
  type Vec3,
} from "../content/model";
import { UvEditor } from "../content/UvEditor";
import { Viewport, type GizmoMode, type PaintHit, type Part, type TextureSource, type ViewName } from "../content/Viewport";
import { PaintCanvas, type PaintModifiers, type PaintPhase } from "../content/paint/PaintCanvas";
import { PaintTools, usePaintState } from "../content/paint/PaintTools";
import { blankImage, cloneImage, decodeImage, getPixel, sameImage, Stroke, toPngDataUrl, type PixelImage } from "../content/paint/pixels";
import { spriteLayerElements } from "../content/spriteElements";
import "./ContentEditor.css";

export const CONTENT_SOURCE_VIEW = "yog.content.source";

/** Which model of the file is being edited. */
type ModelKey = "model" | "item_model" | "arm";

/** A raw parent model (`content_parent_model`), parents flattened. */
interface ParentModel {
  textures?: Record<string, string>;
  elements?: Element[];
  display?: Partial<Record<DisplaySlot, DisplayTransform>>;
  parent?: string;
}

/** A model as drawn: its elements (own, a template's, or a parent's), textures resolved, display. */
interface Resolved {
  elements: Element[];
  /** Slot → texture value (`#refs` followed). */
  textures: Record<string, string>;
  /** Slots this model can use (its own and inherited), for pickers. */
  slots: string[];
  /** An item sprite: its layers (`layer0`, …) with textures, in order. */
  sprite?: { slot: string; texture: string }[];
  /** The elements are the model's own (editable). */
  own: boolean;
  display: Partial<Record<DisplaySlot, DisplayTransform>>;
}

const isSpriteParent = (p?: string) => !!p && /(^|[:/])(generated|handheld)$|builtin\/generated/.test(p);

function modelOf(f: ContentFile, key: ModelKey): Model | undefined {
  if (key === "arm") return f.states?.connect?.arm;
  return f[key];
}

function ensureModel(f: ContentFile, key: ModelKey): Model {
  if (key === "arm") {
    f.states ??= {};
    f.states.connect ??= { arm: {} };
    return f.states.connect.arm;
  }
  return (f[key] ??= {});
}

function resolve(model: Model | undefined, kind: "block" | "item", parents: Record<string, ParentModel | null>): Resolved {
  const m = model ?? {};
  const parent = m.parent;
  const tpl = templateOf(parent);
  const raw = parent && !tpl ? parents[parent] : undefined;
  const textures: Record<string, string> = { ...(raw?.textures ?? {}), ...(m.textures ?? {}) };
  const follow = (v: string | undefined): string | undefined => {
    for (let i = 0; i < 16 && v?.startsWith("#"); i++) v = textures[v.slice(1)];
    return v?.startsWith("#") ? undefined : v;
  };
  const resolved: Record<string, string> = {};
  for (const k of Object.keys(textures)) {
    const v = follow(textures[k]);
    if (v) resolved[k] = v;
  }
  const slots = [...new Set([...(tpl?.slots ?? []), ...Object.keys(textures)])];
  const spriteLayers = () =>
    Object.keys(textures)
      .filter((k) => /^layer\d+$/.test(k))
      .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
      .filter((k) => !!resolved[k])
      .map((slot) => ({ slot, texture: resolved[slot] }));
  let display: Resolved["display"];
  if (tpl?.sprite) display = defaultDisplay(parent === "handheld" ? "handheld" : "generated");
  else if (raw) display = raw.display ?? {};
  else if (kind === "item" && !m.elements?.length && !tpl) display = defaultDisplay("generated");
  else display = defaultDisplay("block");
  display = { ...display, ...(m.display ?? {}) };
  if (m.elements?.length) return { elements: m.elements, textures: resolved, slots, own: true, display };
  if (tpl?.sprite || (raw && !raw.elements && isSpriteParent(raw.parent)))
    return { elements: [], textures: resolved, slots: slots.length ? slots : ["layer0"], sprite: spriteLayers(), own: false, display };
  if (tpl) return { elements: templateElements(tpl.name) ?? [], textures: resolved, slots, own: false, display };
  if (raw?.elements) return { elements: raw.elements, textures: resolved, slots, own: false, display };
  // No elements yet — an empty, editable model.
  return { elements: [], textures: resolved, slots, own: !parent, display };
}

/** A texture as loaded: its image, and whether it's the mod's own file (paintable in place). */
type LoadedTexture = TextureSource & { writable: boolean };

/** One step of undo: the file's text and the textures it touched (`null`: the texture didn't exist — a new one). */
interface HistoryEntry {
  text: string;
  pixels: Record<string, PixelImage | null>;
}

/** A texture painted in the editor (not saved yet, or saved and still shown from memory). */
interface Edited {
  img: PixelImage;
  url: string;
}

const LAYER = /^layer(\d+)$/;
const layerIndex = (slot: string) => Number(LAYER.exec(slot)?.[1] ?? -1);

/** Every texture value the file's models name. */
function namedTextures(f: ContentFile): Set<string> {
  const out = new Set<string>();
  for (const m of [f.model, f.item_model, f.states?.connect?.arm]) for (const v of Object.values(m?.textures ?? {})) out.add(v);
  return out;
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
const vecText = (v: readonly number[] | undefined) => (v ? v.map(fmt).join(", ") : "");

/** `n` numbers from `1, 2, 3` — or what's wrong: `"count"` (not `n` numbers) or `"range"`. */
function parseVec(text: string, n: number, min = -Infinity, max = Infinity): number[] | "count" | "range" {
  const parts = text.split(/[,\s]+/).filter(Boolean).map(Number);
  if (parts.length !== n || parts.some((x) => Number.isNaN(x))) return "count";
  if (parts.some((x) => x < min || x > max)) return "range";
  return parts;
}

/** `0,90; 90,0` ↔ rotations. */
const rotationsText = (r: StateRotation[] | undefined) => (r ?? []).map((x) => `${x.x ?? 0},${x.y ?? 0}${x.weight ? `*${x.weight}` : ""}`).join("; ");
function parseRotations(text: string): StateRotation[] | string {
  const out: StateRotation[] = [];
  for (const part of text.split(";").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*,\s*(\d+)(?:\s*\*\s*(\d+))?$/.exec(part);
    if (!m) return "x,y pairs separated by ;, e.g. 0,0; 0,90; 0,180; 0,270";
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (![0, 90, 180, 270].includes(x) || ![0, 90, 180, 270].includes(y)) return "angles must be 0, 90, 180 or 270";
    out.push({ ...(x ? { x } : {}), ...(y ? { y } : {}), ...(m[3] ? { weight: Number(m[3]) } : {}) });
  }
  return out;
}

const ARM_TEMPLATE = (texture: string): Model => ({
  textures: { arm: texture },
  elements: [
    {
      from: [6, 6, 0],
      to: [10, 10, 6],
      faces: Object.fromEntries(DIRS.filter((d) => d !== "south").map((d) => [d, { texture: "#arm", ...(d === "north" ? { cullface: "north" as Dir } : {}) }])),
    },
  ],
});

/**
 * The `.yblock` / `.yitem` editor: the block's or item's 3D model in a
 * Blender-like view (Viewport), an outliner of its elements, its properties
 * (the block/item metadata, the model, the selected element and face, display
 * transforms, block states) in a Properties grid, and a UV editor for the
 * selected face. Every edit rewrites the file (formatted) through `onChange`
 * — dirty state, Save and external reload as for any file; undo/redo steps
 * over the file's text; F7 opens the JSON.
 */
export function ContentEditor({ path, content, onChange, readOnly, contentVersion }: EditorProps) {
  const t = useT();
  const { tabs, setView, setSideState } = useOpenFiles();
  const kind = kindOf(path) ?? "block";
  const parsed = useMemo(() => parseContent(content), [content]);
  const file = useMemo<ContentFile>(() => (parsed.ok ? parsed.file : {}), [parsed]);

  const [modelKey, setModelKey] = useState<ModelKey>("model");
  const [selected, setSelected] = useState<number | null>(null);
  const [face, setFace] = useState<Dir | null>(null);
  const [gizmo, setGizmo] = useState<GizmoMode>("move");
  const [shading, setShading] = useState(true);
  const [grid, setGrid] = useState(true);
  const [displaySlot, setDisplaySlot] = useState<DisplaySlot | "">("");
  const [variant, setVariant] = useState(0);
  const [viewRequest, setViewRequest] = useState<{ view: ViewName; key: number } | null>(null);
  const [images, setImages] = useState<Record<string, LoadedTexture | undefined>>({});
  const [parents, setParents] = useState<Record<string, ParentModel | null>>({});
  const [choices, setChoices] = useState<{ textures: string[]; strings: string[] }>({ textures: [], strings: [] });
  const rootRef = useRef<HTMLDivElement>(null);

  // Paint mode: the textures' pixels, decoded from disk (`decoded`), painted
  // (`edited`), and as last saved (`saved`).
  const [paintMode, setPaintMode] = useState(false);
  const { state: paint, set: setPaint, used: usedColor } = usePaintState("yog.content.paint");
  const [paintSlot, setPaintSlot] = useState<string | null>(null);
  const [tints, setTints] = useState<Record<number, string>>({});
  const [decoded, setDecoded] = useState<Record<string, { url: string; img: PixelImage }>>({});
  const [edited, setEdited] = useState<Record<string, Edited>>({});
  const [saved, setSaved] = useState<Record<string, PixelImage>>({});
  const editedRef = useRef(edited);
  editedRef.current = edited;

  // A model key that no longer exists (the arm removed, say) → the main model.
  const effectiveKey: ModelKey = modelOf(file, modelKey) || modelKey === "model" ? modelKey : "model";
  const model = modelOf(file, effectiveKey);
  const modelKind = effectiveKey === "item_model" || kind === "item" ? "item" : "block";
  const resolved = useMemo(() => resolve(model, modelKind, parents), [model, modelKind, parents]);
  const mainResolved = useMemo(() => resolve(file.model, kind, parents), [file.model, kind, parents]);
  const elements = resolved.elements;
  const sel = selected !== null && selected < elements.length ? selected : null;
  const selEl = sel !== null ? elements[sel] : undefined;

  // ── Undo/redo over the file's text ────────────────────────────────────────

  const contentRef = useRef(content);
  contentRef.current = content;
  const history = useRef<{ past: HistoryEntry[]; future: HistoryEntry[] }>({ past: [], future: [] });
  useEffect(() => {
    history.current = { past: [], future: [] };
    setImages({});
    setEdited({});
    setSaved({});
    notifyDocumentCommands();
  }, [contentVersion]);

  const pushHistory = useCallback((entry: HistoryEntry) => {
    history.current.past.push(entry);
    history.current.future = [];
    notifyDocumentCommands();
  }, []);

  /** Sets painted textures (`null`: back to what's on disk / gone). */
  const setEditedImages = useCallback((patch: Record<string, PixelImage | null>) => {
    const next = { ...editedRef.current };
    for (const [k, img] of Object.entries(patch)) {
      if (img) next[k] = { img, url: toPngDataUrl(img) };
      else delete next[k];
    }
    editedRef.current = next;
    setEdited(next);
  }, []);

  const update = useCallback(
    (edit: (draft: ContentFile) => void) => {
      if (readOnly || !parsed.ok) return;
      const draft = clone(parsed.file);
      edit(draft);
      const text = serializeContent(draft);
      if (text === contentRef.current) return;
      pushHistory({ text: contentRef.current, pixels: {} });
      onChange(text);
    },
    [onChange, readOnly, parsed, pushHistory]
  );

  const step = useCallback(
    (back: boolean) => {
      const h = history.current;
      const entry = (back ? h.past : h.future).pop();
      if (entry === undefined || readOnly) return;
      const cur = editedRef.current;
      (back ? h.future : h.past).push({
        text: contentRef.current,
        pixels: Object.fromEntries(Object.keys(entry.pixels).map((k) => [k, cur[k]?.img ?? null])),
      });
      if (entry.text !== contentRef.current) onChange(entry.text);
      if (Object.keys(entry.pixels).length) setEditedImages(entry.pixels);
      notifyDocumentCommands();
    },
    [onChange, readOnly, setEditedImages]
  );

  /** Edits the current model's own elements (copying a template's/parent's in first). */
  const editElements = useCallback(
    (edit: (els: Element[], m: Model) => void) =>
      update((d) => {
        const m = ensureModel(d, effectiveKey);
        if (!m.elements?.length) {
          m.elements = clone(resolved.elements);
          if (m.parent && (templateOf(m.parent) || parents[m.parent])) {
            m.textures = { ...(parents[m.parent]?.textures ?? {}), ...(m.textures ?? {}) };
            delete m.parent;
          }
        }
        edit(m.elements, m);
      }),
    [update, effectiveKey, resolved, parents]
  );

  // ── Pickers' choices, parent models, textures ─────────────────────────────

  useEffect(() => {
    let live = true;
    void Promise.all([
      invoke<{ value: string }[]>("content_textures", { path }).catch(() => []),
      invoke<string[]>("content_strings", { path }).catch(() => []),
    ]).then(([tex, strings]) => live && setChoices({ textures: tex.map((c) => c.value), strings }));
    return () => {
      live = false;
    };
  }, [path, contentVersion]);

  const rawParents = useMemo(() => {
    const ids = new Set<string>();
    for (const m of [file.model, file.item_model, file.states?.connect?.arm]) if (m?.parent && !templateOf(m.parent)) ids.add(m.parent);
    return [...ids];
  }, [file]);
  useEffect(() => {
    for (const id of rawParents) {
      if (id in parents) continue;
      setParents((p) => ({ ...p, [id]: null }));
      invoke<ParentModel>("content_parent_model", { path, id })
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
      invoke<LoadedTexture>("content_texture", { path, texture: value })
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

  /** What the view and the pickers show: painted textures over the loaded ones. */
  const shownImages = useMemo(() => {
    const out: Record<string, LoadedTexture | undefined> = { ...images };
    for (const [k, e] of Object.entries(edited)) out[k] = { url: e.url, animated: images[k]?.animated ?? false, writable: true };
    return out;
  }, [images, edited]);

  const saveState = useRef({ dirtyKeys, edited, images });
  saveState.current = { dirtyKeys, edited, images };
  const saveTextures = useCallback(async () => {
    const { dirtyKeys: keys, edited: cur } = saveState.current;
    const written: Record<string, Edited> = {};
    for (const key of keys) {
      const e = cur[key];
      await invoke<string>("content_save_texture", { path, texture: key, png: e.url.slice(e.url.indexOf(",") + 1) });
      written[key] = e;
    }
    setSaved((s) => ({ ...s, ...Object.fromEntries(Object.entries(written).map(([k, e]) => [k, e.img])) }));
    setImages((m) => {
      const next = { ...m };
      for (const [k, e] of Object.entries(written)) next[k] = { url: e.url, animated: m[k]?.animated ?? false, writable: true };
      return next;
    });
  }, [path]);
  const sideDirty = !readOnly && dirtyKeys.length > 0;
  useEffect(() => setSideState(path, { dirty: sideDirty, save: saveTextures }), [path, sideDirty, saveTextures, setSideState]);
  useEffect(() => () => setSideState(path, null), [path, setSideState]);

  // A texture changed on disk (another editor, git) shows up when the window
  // regains focus — unless it has unsaved paint here.
  useEffect(() => {
    const recheck = () => {
      const { dirtyKeys: keys, images: cur } = saveState.current;
      for (const key of Object.keys(cur)) {
        if (keys.includes(key)) continue;
        invoke<LoadedTexture>("content_texture", { path, texture: key })
          .then((src) => {
            if (saveState.current.images[key]?.url === src.url) return;
            setImages((m) => ({ ...m, [key]: src }));
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
  }, [path, setEditedImages]);

  // ── What the view draws ───────────────────────────────────────────────────

  const rotations = file.states?.rotations ?? [];
  const rot = effectiveKey === "model" ? rotations[variant] : undefined;
  const parts = useMemo<Part[]>(() => {
    const own: Part = {
      elements: resolved.elements,
      textures: resolved.textures,
      sprite: resolved.sprite,
      tints,
      editable: true,
      x: rot?.x,
      y: rot?.y,
    };
    if (effectiveKey !== "arm") return [own];
    return [{ elements: mainResolved.elements, textures: mainResolved.textures, sprite: mainResolved.sprite, ghost: true }, own];
  }, [resolved, mainResolved, effectiveKey, rot, tints]);

  const display = useMemo(() => {
    if (!displaySlot) return null;
    return { slot: displaySlot, transform: resolved.display[displaySlot] ?? {} };
  }, [displaySlot, resolved]);

  const onSelect = useCallback((el: number | null, f: Dir | null) => {
    setSelected(el);
    setFace(f);
  }, []);

  const onTransform = useCallback(
    (index: number, from: Vec3, to: Vec3) =>
      editElements((els) => {
        els[index].from = from;
        els[index].to = to;
      }),
    [editElements]
  );

  // ── Painting ──────────────────────────────────────────────────────────────

  const paintOn = !readOnly && (paintMode || !!resolved.sprite);
  const faceSlot = selEl && face ? selEl.faces[face]?.texture.replace(/^#/, "") : undefined;
  const paintSlots = resolved.slots.filter((s) => resolved.textures[s] && s !== "particle");
  const activeSlot = paintSlot && paintSlots.includes(paintSlot) ? paintSlot : faceSlot && paintSlots.includes(faceSlot) ? faceSlot : (paintSlots[0] ?? null);
  const activeKey = activeSlot ? resolved.textures[activeSlot] : undefined;
  // The 2D view follows the face picked in the outliner or the view.
  useEffect(() => {
    if (faceSlot) setPaintSlot(faceSlot);
  }, [faceSlot]);

  /** A new png under `resources/` for `slot` — `item/<file>.png`, `block/<file>_<slot>.png` and the like, not yet taken. */
  const newTexturePath = (slot: string): string => {
    const stem = (path.split(/[\\/]/).pop() ?? "texture").replace(/\.(yblock|yitem)$/i, "").toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
    const folder = modelKind === "item" || resolved.sprite ? "item" : "block";
    const several = paintSlots.length > 1 || effectiveKey === "arm";
    const base = `${folder}/${stem}${several ? `_${slot}` : ""}`;
    const taken = new Set([...choices.textures, ...Object.keys(editedRef.current), ...named]);
    let value = `${base}.png`;
    for (let n = 2; taken.has(value); n++) value = `${base}_${n}.png`;
    return value;
  };

  /** Points `slot` at a new texture `img` (a copy, or a blank one) — one undo step with `entry`'s text. */
  const assignTexture = (slot: string, img: PixelImage): { key: string; entry: HistoryEntry } => {
    const key = newTexturePath(slot);
    const entry: HistoryEntry = { text: contentRef.current, pixels: { [key]: null } };
    const draft = clone(file);
    const m = ensureModel(draft, effectiveKey);
    m.textures = { ...(m.textures ?? {}), [slot]: key };
    onChange(serializeContent(draft));
    setEditedImages({ [key]: img });
    return { key, entry };
  };

  const stroke = useRef<{ stroke: Stroke; slot: string; key: string; entry: HistoryEntry; frame: number } | null>(null);

  const beginPaint = (slot: string, x: number, y: number, pick: boolean) => {
    if (!paintOn || stroke.current) return;
    let key = resolved.textures[slot];
    let base = pixelsOf(key);
    if (!key || !base) return;
    if (paint.tool === "picker" || pick) {
      const c = getPixel(base, x, y);
      if (c) setPaint({ color: c, ...(paint.tool === "picker" ? { tool: "pencil" as const } : {}) });
      return;
    }
    if (paint.tool === "fill" && !getPixel(base, x, y)) return;
    let entry: HistoryEntry;
    const writable = images[key]?.writable ?? key in editedRef.current;
    if (!writable) {
      // Not the mod's texture (Minecraft's, another mod's): paint a copy in the mod.
      base = cloneImage(base);
      ({ key, entry } = assignTexture(slot, base));
      notify({ level: "info", message: t("Copied into the mod: {path}", { path: `resources/${key}` }) });
    } else entry = { text: contentRef.current, pixels: { [key]: base } };
    const s = new Stroke(base, paint, x, y);
    stroke.current = { stroke: s, slot, key, entry, frame: 0 };
    setEditedImages({ [key]: s.image });
  };

  const movePaint = (x: number, y: number) => {
    const cur = stroke.current;
    if (!cur) return;
    cur.stroke.move(x, y);
    // At most one redraw a frame.
    if (!cur.frame)
      cur.frame = requestAnimationFrame(() => {
        cur.frame = 0;
        if (stroke.current === cur) setEditedImages({ [cur.key]: cur.stroke.image });
      });
  };

  const endPaint = () => {
    const cur = stroke.current;
    if (!cur) return;
    stroke.current = null;
    cancelAnimationFrame(cur.frame);
    setEditedImages({ [cur.key]: cur.stroke.image });
    const copied = cur.entry.pixels[cur.key] === null;
    if (copied || !sameImage(cur.stroke.image, cur.stroke.base)) {
      pushHistory(cur.entry);
      if (cur.stroke.settings.tool !== "eraser") usedColor(cur.stroke.settings.color);
    }
  };

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
    const { entry } = assignTexture(slot, blankImage(n, n));
    pushHistory(entry);
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
    const { entry } = assignTexture(slot, blankImage(first?.w ?? 16, first?.h ?? 16));
    pushHistory(entry);
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
      els.push(...spriteLayerElements(img, slot, i, images[texture]?.animated ? img.w : img.h));
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

  // ── Element commands ──────────────────────────────────────────────────────

  const firstSlot = resolved.slots[0];
  const addElement = () => {
    const slot = firstSlot ?? "0";
    editElements((els, m) => {
      if (!firstSlot) m.textures = { ...(m.textures ?? {}), [slot]: "minecraft:block/stone" };
      els.push({
        name: `cube${els.length + 1}`,
        from: [4, 0, 4],
        to: [12, 8, 12],
        faces: Object.fromEntries(DIRS.map((d) => [d, { texture: `#${slot}` }])),
      });
      setSelected(els.length - 1);
      setFace(null);
    });
  };
  const duplicateElement = () => {
    if (sel === null) return;
    editElements((els) => {
      els.splice(sel + 1, 0, { ...clone(els[sel]), name: els[sel].name ? `${els[sel].name}_copy` : undefined });
      setSelected(sel + 1);
    });
  };
  const deleteElement = () => {
    if (sel === null) return;
    editElements((els) => {
      els.splice(sel, 1);
      setSelected(els.length ? Math.min(sel, els.length - 1) : null);
      setFace(null);
    });
  };
  const moveElement = (by: -1 | 1) => {
    if (sel === null || sel + by < 0 || sel + by >= elements.length) return;
    editElements((els) => {
      const [el] = els.splice(sel, 1);
      els.splice(sel + by, 0, el);
      setSelected(sel + by);
    });
  };

  const addSlot = async () => {
    const slot = await promptDialog({
      title: t("Add Texture Slot"),
      label: t("Slot"),
      confirmLabel: t("Add"),
      validate: (v) => (/^[a-z0-9_]+$/.test(v) ? (resolved.slots.includes(v) ? t("This slot already exists.") : null) : t("Lowercase letters, digits and _.")),
    });
    if (slot) update((d) => void (ensureModel(d, effectiveKey).textures = { ...(ensureModel(d, effectiveKey).textures ?? {}), [slot]: "minecraft:block/stone" }));
  };

  const viewCode = () => {
    const tab = tabs.find((x) => x.path === path);
    if (tab) void setView(tab.id, CONTENT_SOURCE_VIEW);
  };

  // ── Keyboard and Edit menu ────────────────────────────────────────────────

  const inField = () => {
    const el = document.activeElement;
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
  };
  const focusedWithin = () => !!rootRef.current && rootRef.current.contains(document.activeElement);
  const editable = () => !readOnly && focusedWithin() && !inField();
  /** Copies the selected element as JSON (pasteable into another model, or Blockbench-style text). */
  const copyElement = async () => {
    if (!selEl) return false;
    await navigator.clipboard.writeText(serializeContent(selEl as unknown as ContentFile));
    return true;
  };
  const pasteElement = async () => {
    let value: unknown;
    try {
      value = JSON.parse(await navigator.clipboard.readText());
    } catch {
      return;
    }
    const list = (Array.isArray(value) ? value : [value]).filter(
      (v): v is Element => !!v && typeof v === "object" && Array.isArray((v as Element).from) && Array.isArray((v as Element).to) && typeof (v as Element).faces === "object"
    );
    if (!list.length) return;
    editElements((els) => {
      const at = sel === null ? els.length : sel + 1;
      els.splice(at, 0, ...list);
      setSelected(at);
      setFace(null);
    });
  };
  const commands = useRef({ step, deleteElement, duplicateElement, copyElement, pasteElement, sel, elements });
  commands.current = { step, deleteElement, duplicateElement, copyElement, pasteElement, sel, elements };
  useKeybinding("Ctrl+Z", () => commands.current.step(true), { when: editable });
  useKeybinding(["Ctrl+Y", "Ctrl+Shift+Z"], () => commands.current.step(false), { when: editable });
  useKeybinding("Delete", () => commands.current.deleteElement(), { when: editable });
  useKeybinding("Ctrl+C", () => void commands.current.copyElement(), { when: editable });
  useKeybinding("Ctrl+X", () => void commands.current.copyElement().then((ok) => ok && commands.current.deleteElement()), { when: editable });
  useKeybinding("Ctrl+V", () => void commands.current.pasteElement(), { when: editable });
  useKeybinding("Ctrl+D", () => commands.current.duplicateElement(), { when: editable });
  const pickGizmo = (g: GizmoMode) => {
    setGizmo(g);
    setPaintMode(false);
  };
  useKeybinding("G", () => pickGizmo("move"), { when: editable });
  useKeybinding("S", () => pickGizmo("resize"), { when: editable });
  useKeybinding("P", () => setPaintMode(true), { when: editable });
  const painting = () => editable() && (paintMode || !!resolved.sprite);
  const paintRef = useRef(paint);
  paintRef.current = paint;
  useKeybinding("B", () => setPaint({ tool: "pencil" }), { when: painting });
  useKeybinding("E", () => setPaint({ tool: "eraser" }), { when: painting });
  useKeybinding("F", () => setPaint({ tool: "fill" }), { when: painting });
  useKeybinding("I", () => setPaint({ tool: "picker" }), { when: painting });
  useKeybinding("L", () => setPaint({ tool: "line" }), { when: painting });
  useKeybinding("R", () => setPaint({ tool: "rect" }), { when: painting });
  useKeybinding("M", () => setPaint({ mirrorX: !paintRef.current.mirrorX }), { when: painting });
  useKeybinding("[", () => setPaint({ size: Math.max(1, paintRef.current.size - 1) }), { when: painting });
  useKeybinding("]", () => setPaint({ size: Math.min(4, paintRef.current.size + 1) }), { when: painting });
  useKeybinding("F7", viewCode, { when: focusedWithin });

  useEffect(
    () =>
      registerDocumentCommands(path, {
        canUndo: () => !readOnly && history.current.past.length > 0,
        undo: () => commands.current.step(true),
        canRedo: () => !readOnly && history.current.future.length > 0,
        redo: () => commands.current.step(false),
        hasSelection: () => commands.current.sel !== null,
        cut: () => void commands.current.copyElement().then((ok) => ok && commands.current.deleteElement()),
        copy: () => void commands.current.copyElement(),
        canPaste: () => !readOnly,
        paste: () => void commands.current.pasteElement(),
        selectAll: () => {},
        delete: () => commands.current.deleteElement(),
      }),
    [path, readOnly]
  );
  useEffect(() => notifyDocumentCommands(), [sel]);

  // ── Properties ────────────────────────────────────────────────────────────

  const properties = useMemo<PropertyDescriptor[]>(() => {
    const out: PropertyDescriptor[] = [];
    const ro = readOnly;
    /** Optional number as text: empty = unset. */
    const num = (
      id: string,
      name: string,
      category: string,
      value: number | undefined,
      set: (v: number | undefined) => void,
      opts: { min?: number; max?: number; int?: boolean; description?: string } = {}
    ): PropertyDescriptor => ({
      id,
      name,
      category,
      description: opts.description,
      value: value ?? "",
      kind: "string",
      readOnly: ro,
      validate: (v) => {
        const s = String(v).trim();
        if (s === "") return null;
        const n = Number(s);
        if (Number.isNaN(n)) return t("Not a valid number.");
        if (opts.int && !Number.isInteger(n)) return t("A whole number.");
        if ((opts.min !== undefined && n < opts.min) || (opts.max !== undefined && n > opts.max))
          return t("Between {min} and {max}.", { min: opts.min ?? "-∞", max: opts.max ?? "∞" });
        return null;
      },
      onCommit: (v) => set(String(v).trim() === "" ? undefined : Number(v)),
    });
    const text = (id: string, name: string, category: string, value: string | undefined, set: (v: string | undefined) => void, extra: Partial<PropertyDescriptor> = {}): PropertyDescriptor => ({
      id,
      name,
      category,
      value: value ?? "",
      kind: "string",
      readOnly: ro,
      onCommit: (v) => set(String(v).trim() === "" ? undefined : String(v).trim()),
      ...extra,
    });
    const choice = (id: string, name: string, category: string, value: string | undefined, options: readonly string[], set: (v: string | undefined) => void, extra: Partial<PropertyDescriptor> = {}): PropertyDescriptor => ({
      id,
      name,
      category,
      value: value ?? "",
      kind: "enum",
      options: ["", ...options],
      readOnly: ro,
      onCommit: (v) => set(String(v) === "" ? undefined : String(v)),
      ...extra,
    });
    const flag = (id: string, name: string, category: string, value: boolean | undefined, set: (v: boolean | undefined) => void, def: boolean, extra: Partial<PropertyDescriptor> = {}): PropertyDescriptor => ({
      id,
      name,
      category,
      value: value ?? def,
      kind: "bool",
      readOnly: ro,
      onCommit: (v) => set(v === def ? undefined : Boolean(v)),
      ...extra,
    });
    const vec = (id: string, name: string, category: string, value: readonly number[] | undefined, n: number, set: (v: number[] | undefined) => void, min?: number, max?: number, optional = true): PropertyDescriptor => ({
      id,
      name,
      category,
      value: vecText(value),
      kind: "string",
      readOnly: ro,
      validate: (v) => {
        if (optional && String(v).trim() === "") return null;
        const r = parseVec(String(v), n, min, max);
        if (r === "count") return t("{n} numbers, comma-separated.", { n });
        if (r === "range") return t("Between {min} and {max}.", { min: min ?? "-∞", max: max ?? "∞" });
        return null;
      },
      onCommit: (v) => {
        if (String(v).trim() === "") return set(undefined);
        const r = parseVec(String(v), n, min, max);
        if (typeof r !== "string") set(r);
      },
    });
    const prune = (o: Record<string, unknown> | undefined) => !!o && Object.values(o).every((x) => x === undefined);

    // General.
    const general = t("General");
    out.push(
      text("id", t("Id"), general, file.id, (v) => update((d) => void (d.id = v)), {
        description: t("The registry id — `namespace:name`, or just `name` (the mod's namespace). Default: the file name."),
      }),
      text("name", t("Name"), general, file.name, (v) => update((d) => void (d.name = v)), {
        suggestions: choices.strings,
        description: t("Display name — a literal English text or a `@Set.name` text of a .yres file (translated)."),
      }),
      text("tooltip", t("Tooltip"), general, file.tooltip, (v) => update((d) => void (d.tooltip = v)), {
        suggestions: choices.strings,
        description: t("A line under the name — literal or `@Set.name`."),
      }),
      choice("register", t("Registration"), general, file.register, ["auto", "manual"], (v) => update((d) => void (d.register = v as ContentFile["register"])), {
        description: t("auto: registered by yog_api::content!(); manual: you register Blocks::x() / Items::x() yourself (to add behavior)."),
      })
    );

    // Block / item properties.
    if (kind === "block") {
      const c = t("Block");
      const b = file.block ?? {};
      const setB = (edit: (b: NonNullable<ContentFile["block"]>) => void) =>
        update((d) => {
          d.block ??= {};
          edit(d.block);
          if (prune(d.block as Record<string, unknown>)) delete d.block;
        });
      const drops = typeof b.drops === "object" ? (b.drops.item ?? "") : (b.drops ?? "");
      out.push(
        num("hardness", t("Hardness"), c, b.hardness, (v) => setB((x) => void (x.hardness = v)), { min: -1, description: t("Mining time factor (stone 1.5, -1 unbreakable).") }),
        num("resistance", t("Blast Resistance"), c, b.resistance, (v) => setB((x) => void (x.resistance = v)), { min: 0 }),
        choice("sound", t("Sound"), c, b.sound, SOUNDS, (v) => setB((x) => void (x.sound = v))),
        num("light", t("Light Level"), c, b.light, (v) => setB((x) => void (x.light = v)), { min: 0, max: 15, int: true }),
        choice("tool", t("Tool"), c, b.tool, TOOLS, (v) => setB((x) => void (x.tool = v))),
        choice("tool_level", t("Tool Level"), c, b.tool_level, TOOL_LEVELS, (v) => setB((x) => void (x.tool_level = v))),
        flag("requires_tool", t("Requires Tool"), c, b.requires_tool, (v) => setB((x) => void (x.requires_tool = v)), false, { description: t("Drops nothing unless mined with the right tool.") }),
        flag("collision", t("Collision"), c, b.collision, (v) => setB((x) => void (x.collision = v)), true),
        num("slipperiness", t("Slipperiness"), c, b.slipperiness, (v) => setB((x) => void (x.slipperiness = v)), { min: 0, max: 1, description: t("0.6 normal, 0.98 ice.") }),
        choice("render_layer", t("Render Layer"), c, b.render_layer, RENDER_LAYERS, (v) => setB((x) => void (x.render_layer = v)), {
          description: t("cutout for textures with fully transparent pixels, translucent for glass-like ones."),
        }),
        text(
          "shape",
          t("Shape"),
          c,
          Array.isArray(b.shape) ? vecText(b.shape) : b.shape,
          (v) =>
            setB((x) => {
              if (v === undefined || v === "auto" || v === "full") x.shape = v as "auto" | "full" | undefined;
              else {
                const r = parseVec(v, 6, 0, 16);
                if (typeof r !== "string") x.shape = r;
              }
            }),
          {
            suggestions: ["auto", "full"],
            validate: (v) => {
              const s = String(v).trim();
              if (s === "" || s === "auto" || s === "full") return null;
              const r = parseVec(s, 6, 0, 16);
              return typeof r === "string" ? t("auto, full or x1, y1, z1, x2, y2, z2") : null;
            },
            description: t("The outline/collision box: auto (the model's bounds), full, or x1, y1, z1, x2, y2, z2 in pixels."),
          }
        ),
        text(
          "drops",
          t("Drops"),
          c,
          drops,
          (v) =>
            setB((x) => {
              if (v === undefined || v === "self" || v === "none") x.drops = v as "self" | "none" | undefined;
              else x.drops = { ...(typeof x.drops === "object" ? x.drops : {}), item: v };
            }),
          { suggestions: ["self", "none"], description: t("self (default), none, or an item id.") }
        ),
        text(
          "connect_groups",
          t("Connects With"),
          c,
          b.connect_groups?.join(", "),
          (v) => setB((x) => void (x.connect_groups = v ? v.split(/[,\s]+/).filter(Boolean) : undefined)),
          { description: t("Groups of blocks this one connects to (with an arm model in States). Default: itself.") }
        )
      );
    } else {
      const c = t("Item");
      const it = file.item ?? {};
      const setI = (edit: (i: NonNullable<ContentFile["item"]>) => void) =>
        update((d) => {
          d.item ??= {};
          edit(d.item);
          if (prune(d.item as Record<string, unknown>)) delete d.item;
        });
      out.push(
        num("stack_size", t("Stack Size"), c, it.stack_size, (v) => setI((x) => void (x.stack_size = v)), { min: 1, max: 99, int: true }),
        num("durability", t("Durability"), c, it.durability, (v) => setI((x) => void (x.durability = v)), { min: 1, int: true }),
        flag("fire_resistant", t("Fire Resistant"), c, it.fire_resistant, (v) => setI((x) => void (x.fire_resistant = v)), false),
        num("fuel_ticks", t("Fuel Ticks"), c, it.fuel_ticks, (v) => setI((x) => void (x.fuel_ticks = v)), { min: 1, int: true, description: t("Burn time in a furnace (coal: 1600).") }),
        num("nutrition", t("Food: Nutrition"), c, it.food?.nutrition, (v) =>
          setI((x) => {
            if (v === undefined) delete x.food;
            else x.food = { ...(x.food ?? {}), nutrition: v };
          }), { min: 0, int: true }),
        num("saturation", t("Food: Saturation"), c, it.food?.saturation, (v) => setI((x) => void (x.food && (x.food.saturation = v))), { min: 0 }),
        flag("always_edible", t("Food: Always Edible"), c, it.food?.always_edible, (v) => setI((x) => void (x.food && (x.food.always_edible = v))), false)
      );
    }

    // States.
    if (kind === "block") {
      const c = t("States");
      out.push(
        text(
          "rotations",
          t("Random Rotations"),
          c,
          rotationsText(file.states?.rotations),
          (v) =>
            update((d) => {
              const r = v ? parseRotations(v) : [];
              if (typeof r === "string") return;
              d.states ??= {};
              d.states.rotations = r.length ? r : undefined;
              if (prune(d.states as Record<string, unknown>)) delete d.states;
            }),
          {
            suggestions: ["0,0; 0,90; 0,180; 0,270", "0,0; 90,0; 180,0; 270,0; 0,90; 0,270"],
            validate: (v) => {
              const r = String(v).trim() ? parseRotations(String(v)) : [];
              return typeof r === "string" ? t(r) : null;
            },
            description: t("Variants picked at random per position (x,y in degrees, *weight) — like stone's. The toolbar previews each."),
          }
        ),
        {
          id: "connects",
          name: t("Connects"),
          category: c,
          value: !!file.states?.connect,
          kind: "bool",
          readOnly: ro,
          description: t("Adds an arm model drawn towards each neighbor it connects to (fences, pipes)."),
          onCommit: (v) =>
            update((d) => {
              if (v) {
                d.states ??= {};
                d.states.connect ??= { arm: ARM_TEMPLATE(mainResolved.textures[mainResolved.slots[0]] ?? "minecraft:block/stone") };
              } else if (d.states) {
                delete d.states.connect;
                if (prune(d.states as Record<string, unknown>)) delete d.states;
                if (modelKey === "arm") setModelKey("model");
              }
            }),
        },
        ...(file.states?.connect
          ? [flag("arm_uvlock", t("Arm UV Lock"), c, file.states.connect.uvlock, (v) => update((d) => void (d.states!.connect!.uvlock = v)), false)]
          : [])
      );
    }

    // The model.
    const mc = t("Model");
    const setM = (edit: (m: Model) => void) => update((d) => edit(ensureModel(d, effectiveKey)));
    out.push(
      text("parent", t("Parent"), mc, model?.parent, (v) => setM((m) => void (m.parent = v)), {
        suggestions: TEMPLATES.filter((x) => (modelKind === "item" ? true : !x.sprite)).map((x) => x.name),
        description: t("A template (cube_all, cube_column, …, generated, handheld for items) or any model id. Empty: the model's own elements."),
      })
    );
    if (!resolved.sprite) {
      out.push(
        flag("ambient_occlusion", t("Ambient Occlusion"), mc, model?.ambient_occlusion, (v) => setM((m) => void (m.ambient_occlusion = v)), true),
        choice("gui_light", t("GUI Light"), mc, model?.gui_light, ["front", "side"], (v) => setM((m) => void (m.gui_light = v as Model["gui_light"])))
      );
    }

    // Textures.
    const tc = t("Textures");
    for (const slot of resolved.slots) {
      const own = model?.textures?.[slot];
      const shown = resolved.textures[slot];
      const src = shown ? shownImages[shown] : undefined;
      out.push({
        id: `tex:${slot}`,
        name: slot,
        category: tc,
        value: own ?? "",
        displayValue: own ?? (shown ? `${shown} ${t("(inherited)")}` : ""),
        image: src?.url,
        kind: "string",
        suggestions: [...resolved.slots.filter((s) => s !== slot).map((s) => `#${s}`), ...choices.textures],
        readOnly: ro,
        description: t("@Set.name (a .yres image), a png path under resources/, a texture id (minecraft:block/stone) or #slot."),
        onCommit: (v) =>
          setM((m) => {
            const s = String(v).trim();
            m.textures ??= {};
            if (s) m.textures[slot] = s;
            else delete m.textures[slot];
            if (!Object.keys(m.textures).length) delete m.textures;
          }),
      });
    }

    // Display.
    if (displaySlot) {
      const dc = `${t("Display")}: ${displaySlot}`;
      const cur = resolved.display[displaySlot] ?? {};
      const setD = (k: keyof DisplayTransform, v: number[] | undefined) =>
        setM((m) => {
          m.display ??= {};
          const tr = { ...cur, ...(m.display[displaySlot] ?? {}) };
          if (v) tr[k] = v as Vec3;
          else delete tr[k];
          m.display[displaySlot] = tr;
        });
      out.push(
        vec("d.rotation", t("Rotation"), dc, cur.rotation, 3, (v) => setD("rotation", v), -180, 180),
        vec("d.translation", t("Translation"), dc, cur.translation, 3, (v) => setD("translation", v), -80, 80),
        vec("d.scale", t("Scale"), dc, cur.scale, 3, (v) => setD("scale", v), 0, 4)
      );
    }

    // The selected element and face.
    if (selEl && sel !== null) {
      const ec = t("Element");
      const setE = (edit: (e: Element) => void) => editElements((els) => edit(els[sel]));
      const r = selEl.rotation;
      out.push(
        text("e.name", t("Name"), ec, selEl.name, (v) => setE((e) => void (e.name = v))),
        vec("e.from", t("From"), ec, selEl.from, 3, (v) => v && setE((e) => void (e.from = v as Vec3)), -16, 32, false),
        vec("e.to", t("To"), ec, selEl.to, 3, (v) => v && setE((e) => void (e.to = v as Vec3)), -16, 32, false),
        choice("e.axis", t("Rotation Axis"), ec, r?.axis ?? "y", ["x", "y", "z"], (v) =>
          setE((e) => void (e.rotation = { origin: [8, 8, 8], angle: 0, ...(e.rotation ?? {}), axis: (v ?? "y") as Axis }))
        ),
        {
          id: "e.angle",
          name: t("Rotation Angle"),
          category: ec,
          value: String(r?.angle ?? 0),
          kind: "enum",
          options: ANGLES.map(String),
          readOnly: ro,
          description: t("Minecraft allows one axis and -45, -22.5, 0, 22.5 or 45 degrees."),
          onCommit: (v) =>
            setE((e) => {
              const angle = Number(v);
              if (!angle && (!e.rotation?.origin || vecText(e.rotation.origin) === "8, 8, 8")) delete e.rotation;
              else e.rotation = { axis: "y", origin: [8, 8, 8], ...(e.rotation ?? {}), angle };
            }),
        },
        vec("e.origin", t("Rotation Origin"), ec, r?.origin ?? [8, 8, 8], 3, (v) => setE((e) => void (e.rotation = { axis: "y", angle: 0, ...(e.rotation ?? {}), origin: (v ?? [8, 8, 8]) as Vec3 })), -16, 32),
        flag("e.rescale", t("Rescale"), ec, r?.rescale, (v) => setE((e) => void (e.rotation && (e.rotation.rescale = v))), false, { readOnly: ro || !r?.angle }),
        flag("e.shade", t("Shade"), ec, selEl.shade, (v) => setE((e) => void (e.shade = v)), true)
      );
      const fc = t("Faces");
      for (const d of DIRS) {
        out.push({
          id: `e.face.${d}`,
          name: t(d),
          category: fc,
          value: !!selEl.faces[d],
          kind: "bool",
          readOnly: ro,
          onCommit: (v) =>
            setE((e) => {
              if (v) e.faces[d] = { texture: `#${resolved.slots[0] ?? "0"}` };
              else delete e.faces[d];
            }),
        });
      }
      const f = face ? selEl.faces[face] : undefined;
      if (face && f) {
        const c = `${t("Face")}: ${t(face)}`;
        const setF = (edit: (x: NonNullable<Element["faces"][Dir]>) => void) => setE((e) => edit(e.faces[face]!));
        out.push(
          choice("f.texture", t("Texture"), c, f.texture.replace(/^#/, ""), resolved.slots, (v) => v && setF((x) => void (x.texture = `#${v}`))),
          vec("f.uv", t("UV"), c, f.uv, 4, (v) => setF((x) => void (x.uv = v as Uv | undefined)), 0, 16),
          choice("f.rotation", t("UV Rotation"), c, String(f.rotation ?? 0), ["0", "90", "180", "270"], (v) => setF((x) => void (x.rotation = v && v !== "0" ? Number(v) : undefined))),
          choice("f.cullface", t("Cull Face"), c, f.cullface, DIRS, (v) => setF((x) => void (x.cullface = v as Dir | undefined)), {
            description: t("Not drawn when a full block is on that side."),
          }),
          num("f.tint", t("Tint Index"), c, f.tint, (v) => setF((x) => void (x.tint = v)), { min: 0, int: true })
        );
      }
    }
    return out;
    // `t` and the helpers read fresh state each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, kind, model, resolved, mainResolved, shownImages, choices, displaySlot, selEl, sel, face, readOnly, effectiveKey, modelKind, modelKey]);

  // ── Layout ────────────────────────────────────────────────────────────────

  if (!parsed.ok) {
    return (
      <div className="content-editor content-broken">
        <p>{t("This file isn't valid JSON: {error}", { error: parsed.error })}</p>
        <Button onClick={viewCode}>{t("View Code")}</Button>
      </div>
    );
  }

  const modelChoices: { value: ModelKey; label: string }[] = [{ value: "model", label: kind === "block" ? t("Block Model") : t("Item Model") }];
  if (kind === "block") {
    modelChoices.push({ value: "item_model", label: file.item_model ? t("Item Model") : t("Item Model (add)") });
    if (file.states?.connect) modelChoices.push({ value: "arm", label: t("Connection Arm") });
  }
  const pickModel = (v: ModelKey) => {
    if (v === "item_model" && !file.item_model) update((d) => void (d.item_model = { parent: "generated", textures: { layer0: mainResolved.textures[mainResolved.slots[0]] ?? "minecraft:item/apple" } }));
    setModelKey(v);
    setSelected(null);
    setFace(null);
  };

  const faceData = selEl && face ? selEl.faces[face] : undefined;
  const faceTexture = faceData ? resolved.textures[faceData.texture.replace(/^#/, "")] : undefined;
  const otherUvs =
    selEl && face && faceData
      ? DIRS.filter((d) => d !== face && selEl.faces[d]?.texture === faceData.texture).map((d) => selEl.faces[d]!.uv ?? autoUv(d, selEl.from, selEl.to))
      : [];

  // The 2D paint view: the active slot's texture, the selected element's faces on it outlined.
  const activeImg = pixelsOf(activeKey);
  const overlays: { rect: [number, number, number, number]; primary?: boolean }[] = [];
  if (paintOn && activeImg && activeSlot && selEl && !resolved.sprite) {
    const sx = activeImg.w / 16;
    const sy = (images[activeKey!]?.animated ? activeImg.w : activeImg.h) / 16;
    for (const d of DIRS) {
      const f = selEl.faces[d];
      if (!f || f.texture.replace(/^#/, "") !== activeSlot) continue;
      const [u0, v0, u1, v1] = f.uv ?? autoUv(d, selEl.from, selEl.to);
      overlays.push({ rect: [u0 * sx, v0 * sy, u1 * sx, v1 * sy], primary: d === face });
    }
  }
  const activeForeign = !!activeKey && !!images[activeKey] && !images[activeKey]!.writable;
  const spriteNote = resolved.sprite
    ? t("Paint the layers here or right on the model. To shape the item in 3D, convert it to elements.")
    : null;

  const paintPanel = paintOn && (
    <>
      <div className="content-pane-header">
        <span>{t("Paint")}</span>
        <span className="content-spacer" />
        <Button variant="ghost" onClick={() => void newTexture()} title={t("A blank texture for the slot being painted")}>
          {t("New Texture…")}
        </Button>
      </div>
      <PaintTools paint={paint} onChange={setPaint} disabled={readOnly} />
    </>
  );

  const layersPanel = resolved.sprite && (
    <>
      <div className="content-pane-header">
        <span>{t("Layers")}</span>
        <span className="content-spacer" />
        <IconButton title={t("Add Layer")} disabled={readOnly} onClick={addLayer}>
          <Icon name="plus" />
        </IconButton>
        <IconButton title={t("Move Up")} disabled={readOnly || !activeSlot || layerIndex(activeSlot) <= 0} onClick={() => activeSlot && moveLayer(activeSlot, -1)}>
          <Icon name="arrowUp" />
        </IconButton>
        <IconButton
          title={t("Move Down")}
          disabled={readOnly || !activeSlot || layerIndex(activeSlot) < 0 || layerIndex(activeSlot) >= layers.length - 1}
          onClick={() => activeSlot && moveLayer(activeSlot, 1)}
        >
          <Icon name="arrowDown" />
        </IconButton>
        <IconButton title={t("Remove Layer")} disabled={readOnly || layers.length < 2 || !activeSlot} onClick={() => activeSlot && removeLayer(activeSlot)}>
          <Icon name="trash" />
        </IconButton>
      </div>
      <ul className="content-elements content-layers" role="listbox">
        {[...layers].reverse().map((slot) => {
          const value = resolved.textures[slot];
          const index = layerIndex(slot);
          return (
            <li key={slot} role="option" aria-selected={slot === activeSlot} className={slot === activeSlot ? "selected" : undefined} onClick={() => setPaintSlot(slot)}>
              <span className="content-layer-thumb">{value && shownImages[value] && <img src={shownImages[value]!.url} alt="" />}</span>
              <span className="content-element-name" title={value}>
                {slot}
                <span className="content-element-size"> {value ?? ""}</span>
              </span>
              <label className="content-tint" title={t("Tint preview (tint index {n}) — right-click to clear", { n: index })} onClick={(e) => e.stopPropagation()}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTints(({ [index]: _, ...rest }) => rest);
                }}
              >
                <span style={{ background: tints[index] ?? "transparent" }} />
                <input type="color" value={tints[index] ?? "#ffffff"} onChange={(e) => setTints((m) => ({ ...m, [index]: e.target.value }))} />
              </label>
            </li>
          );
        })}
      </ul>
      <p className="content-note">{spriteNote}</p>
      <div className="content-pane-actions">
        <Button variant="subtle" disabled={readOnly} onClick={() => void convertToElements()}>
          {t("Convert to 3D Elements")}
        </Button>
      </div>
    </>
  );

  const elementsPanel = !resolved.sprite && (
    <>
      <div className="content-pane-header">
        <span>{t("Elements")}</span>
        <span className="content-spacer" />
        <IconButton title={t("Add Element")} disabled={readOnly} onClick={addElement}>
          <Icon name="plus" />
        </IconButton>
        <IconButton title={`${t("Duplicate")} (Ctrl+D)`} disabled={readOnly || sel === null} onClick={duplicateElement}>
          <Icon name="split" />
        </IconButton>
        <IconButton title={t("Move Up")} disabled={readOnly || sel === null || sel === 0} onClick={() => moveElement(-1)}>
          <Icon name="arrowUp" />
        </IconButton>
        <IconButton title={t("Move Down")} disabled={readOnly || sel === null || sel === elements.length - 1} onClick={() => moveElement(1)}>
          <Icon name="arrowDown" />
        </IconButton>
        <IconButton title={`${t("Delete")} (Del)`} disabled={readOnly || sel === null} onClick={deleteElement}>
          <Icon name="trash" />
        </IconButton>
      </div>
      {!resolved.own && elements.length > 0 && (
        <p className="content-note">{t("These elements come from {parent}. Editing one copies them into this model.", { parent: model?.parent ?? "" })}</p>
      )}
      <ul className="content-elements" role="listbox">
        {elements.map((el, i) => (
          <li key={i} role="option" aria-selected={i === sel} className={i === sel ? "selected" : undefined} onClick={() => onSelect(i, null)}>
            <Icon name={i === sel ? "check" : "grid"} size={13} />
            <span className="content-element-name">{el.name ?? `${t("Element")} ${i + 1}`}</span>
            <span className="content-element-size">
              {el.to.map((x, k) => fmt(x - el.from[k])).join("×")}
              {el.rotation?.angle ? ` ↻${el.rotation.angle}°${el.rotation.axis}` : ""}
            </span>
          </li>
        ))}
      </ul>
      {selEl && (
        <div className="content-faces">
          {DIRS.map((d) => (
            <button key={d} type="button" className={`content-face${face === d ? " selected" : ""}${selEl.faces[d] ? "" : " off"}`} onClick={() => onSelect(sel, d)}>
              {t(d)}
            </button>
          ))}
        </div>
      )}
    </>
  );

  return (
    <div className="content-editor" ref={rootRef}>
      <div className="content-toolbar">
        <SelectField aria-label={t("Model")} value={effectiveKey} options={modelChoices} onChange={(v) => pickModel(v as ModelKey)} />
        <span className="content-divider" />
        <Button variant={!paintOn && gizmo === "move" ? "primary" : "subtle"} disabled={!!resolved.sprite} onClick={() => pickGizmo("move")} title={`${t("Move")} (G)`}>
          {t("Move")}
        </Button>
        <Button variant={!paintOn && gizmo === "resize" ? "primary" : "subtle"} disabled={!!resolved.sprite} onClick={() => pickGizmo("resize")} title={`${t("Resize")} (S)`}>
          {t("Resize")}
        </Button>
        <Button variant={paintOn ? "primary" : "subtle"} disabled={readOnly} onClick={() => setPaintMode(true)} title={`${t("Paint the textures")} (P)`}>
          {t("Paint")}
        </Button>
        <span className="content-divider" />
        <Button variant={shading ? "primary" : "subtle"} onClick={() => setShading((s) => !s)} title={t("Minecraft's per-face shading")}>
          {t("Shading")}
        </Button>
        <Button variant={grid ? "primary" : "subtle"} onClick={() => setGrid((g) => !g)}>
          {t("Grid")}
        </Button>
        <SelectField
          aria-label={t("View")}
          value=""
          options={[
            { value: "", label: t("View…") },
            { value: "front", label: `${t("Front")} (1)` },
            { value: "right", label: `${t("Right")} (3)` },
            { value: "top", label: `${t("Top")} (7)` },
            { value: "back", label: `${t("Back")} (Ctrl+1)` },
            { value: "left", label: `${t("Left")} (Ctrl+3)` },
            { value: "bottom", label: `${t("Bottom")} (Ctrl+7)` },
          ]}
          onChange={(v) => v && setViewRequest({ view: v as ViewName, key: Date.now() })}
        />
        <span className="content-divider" />
        <SelectField
          aria-label={t("Display")}
          value={displaySlot}
          options={[{ value: "", label: t("No display transform") }, ...DISPLAY_SLOTS.map((s) => ({ value: s, label: s }))]}
          onChange={(v) => setDisplaySlot(v as DisplaySlot | "")}
        />
        {displaySlot && model?.display?.[displaySlot] && (
          <Button variant="ghost" disabled={readOnly} onClick={() => update((d) => void delete ensureModel(d, effectiveKey).display?.[displaySlot])}>
            {t("Reset")}
          </Button>
        )}
        {rotations.length > 1 && effectiveKey === "model" && (
          <SelectField
            aria-label={t("Variant")}
            value={String(Math.min(variant, rotations.length - 1))}
            options={rotations.map((r, i) => ({ value: String(i), label: `${t("Variant")} ${i + 1} (x${r.x ?? 0} y${r.y ?? 0})` }))}
            onChange={(v) => setVariant(Number(v))}
          />
        )}
        <span className="content-divider" />
        <Button variant="ghost" disabled={readOnly} onClick={() => void addSlot()}>
          {t("Add Texture Slot…")}
        </Button>
        <span className="content-spacer" />
        <IconButton title={`${t("View Code")} (F7)`} onClick={viewCode}>
          <Icon name="code" />
        </IconButton>
      </div>
      <div className="content-body">
        <div className="content-outliner">
          {paintPanel}
          {layersPanel}
          {elementsPanel}
        </div>
        <div className="content-center">
          {paintOn && (
            <div className="content-paint">
              <div className="content-pane-header">
                <SelectField
                  aria-label={t("Texture")}
                  value={activeSlot ?? ""}
                  options={paintSlots.map((s) => ({ value: s, label: `${s}: ${resolved.textures[s]}` }))}
                  onChange={(v) => setPaintSlot(v)}
                />
                {activeForeign && <span className="content-paint-note">{t("Not the mod's texture — the first stroke copies it into the mod.")}</span>}
              </div>
              <PaintCanvas
                className="content-paint-canvas"
                image={activeImg ?? null}
                overlays={overlays}
                grid={paint.grid}
                brushSize={paint.tool === "pencil" || paint.tool === "eraser" || paint.tool === "line" ? paint.size : 1}
                mirrorX={paint.mirrorX}
                onPaint={readOnly ? undefined : onCanvasPaint}
                emptyText={activeKey ? t("Loading {texture}…", { texture: activeKey }) : t("No texture to paint. Use New Texture… or set a texture slot.")}
              />
            </div>
          )}
          <Viewport
            className="content-viewport"
            parts={parts}
            images={shownImages}
            selected={sel}
            selectedFace={face}
            onSelect={onSelect}
            onTransform={readOnly || paintOn ? undefined : onTransform}
            onPaint={paintOn ? onViewportPaint : null}
            gizmo={gizmo}
            shading={shading}
            showGrid={grid}
            renderLayer={file.block?.render_layer}
            display={display}
            viewRequest={viewRequest}
          />
        </div>
        <div className="content-side">
          <PropertyGrid
            className="content-properties"
            objectName={selEl ? (selEl.name ?? `${t("Element")} ${(sel ?? 0) + 1}`) : (file.name ?? path.split(/[\\/]/).pop())}
            objectType={selEl ? t("Element") : kind === "block" ? t("Block") : t("Item")}
            objectKey={`${effectiveKey}:${sel ?? "-"}:${face ?? "-"}`}
            properties={properties}
            persistKey="yog.content.properties"
          />
          {!paintOn && faceData && face && selEl && (
            <div className="content-uv-pane">
              <div className="content-pane-header">
                <span>
                  {t("UV")}: {t(face)}
                </span>
                <span className="content-spacer" />
                <Button variant="ghost" disabled={readOnly || !faceData.uv} onClick={() => editElements((els) => void delete els[sel!].faces[face]!.uv)}>
                  {t("Auto UV")}
                </Button>
              </div>
              <UvEditor
                image={faceTexture ? shownImages[faceTexture] : undefined}
                uv={faceData.uv ?? autoUv(face, selEl.from, selEl.to)}
                others={otherUvs}
                readOnly={readOnly}
                onCommit={(uv) => editElements((els) => void (els[sel!].faces[face]!.uv = uv))}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
