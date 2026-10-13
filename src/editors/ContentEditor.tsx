import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Button,
  Icon,
  IconButton,
  notifyDocumentCommands,
  PropertyGrid,
  promptDialog,
  registerDocumentCommands,
  SelectField,
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
import { Viewport, type GizmoMode, type Part, type TextureSource, type ViewName } from "../content/Viewport";
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
  sprite?: string[];
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
      .map((k) => resolved[k])
      .filter((v): v is string => !!v);
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

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
const vecText = (v: readonly number[] | undefined) => (v ? v.map(fmt).join(", ") : "");

function parseVec(text: string, n: number, min = -Infinity, max = Infinity): number[] | string {
  const parts = text.split(/[,\s]+/).filter(Boolean).map(Number);
  if (parts.length !== n || parts.some((x) => Number.isNaN(x))) return `${n} numbers, comma-separated`;
  if (parts.some((x) => x < min || x > max)) return `each between ${min} and ${max}`;
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
  const { tabs, setView } = useOpenFiles();
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
  const [images, setImages] = useState<Record<string, TextureSource | undefined>>({});
  const [parents, setParents] = useState<Record<string, ParentModel | null>>({});
  const [choices, setChoices] = useState<{ textures: string[]; strings: string[] }>({ textures: [], strings: [] });
  const rootRef = useRef<HTMLDivElement>(null);

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
  const history = useRef<{ past: string[]; future: string[] }>({ past: [], future: [] });
  useEffect(() => {
    history.current = { past: [], future: [] };
    setImages({});
    notifyDocumentCommands();
  }, [contentVersion]);

  const update = useCallback(
    (edit: (draft: ContentFile) => void) => {
      if (readOnly || !parsed.ok) return;
      const draft = clone(parsed.file);
      edit(draft);
      const text = serializeContent(draft);
      if (text === contentRef.current) return;
      history.current.past.push(contentRef.current);
      history.current.future = [];
      onChange(text);
      notifyDocumentCommands();
    },
    [onChange, readOnly, parsed]
  );

  const step = useCallback(
    (back: boolean) => {
      const h = history.current;
      const text = (back ? h.past : h.future).pop();
      if (text === undefined || readOnly) return;
      (back ? h.future : h.past).push(contentRef.current);
      onChange(text);
      notifyDocumentCommands();
    },
    [onChange, readOnly]
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
      for (const x of r.sprite ?? []) v.add(x);
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
      invoke<TextureSource>("content_texture", { path, texture: value })
        .then((src) => setImages((m) => ({ ...m, [value]: src })))
        .catch(() => setImages((m) => ({ ...m, [value]: undefined })));
    }
  }, [wanted, path, images]);

  // ── What the view draws ───────────────────────────────────────────────────

  const rotations = file.states?.rotations ?? [];
  const rot = effectiveKey === "model" ? rotations[variant] : undefined;
  const parts = useMemo<Part[]>(() => {
    const own: Part = {
      elements: resolved.elements,
      textures: resolved.textures,
      sprite: resolved.sprite,
      editable: true,
      x: rot?.x,
      y: rot?.y,
    };
    if (effectiveKey !== "arm") return [own];
    return [{ elements: mainResolved.elements, textures: mainResolved.textures, sprite: mainResolved.sprite, ghost: true }, own];
  }, [resolved, mainResolved, effectiveKey, rot]);

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
  useKeybinding("G", () => setGizmo("move"), { when: editable });
  useKeybinding("S", () => setGizmo("resize"), { when: editable });
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
        return typeof r === "string" ? t(r) : null;
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
      const src = shown ? images[shown] : undefined;
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
  }, [file, kind, model, resolved, mainResolved, images, choices, displaySlot, selEl, sel, face, readOnly, effectiveKey, modelKind, modelKey]);

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

  return (
    <div className="content-editor" ref={rootRef}>
      <div className="content-toolbar">
        <SelectField aria-label={t("Model")} value={effectiveKey} options={modelChoices} onChange={(v) => pickModel(v as ModelKey)} />
        <span className="content-divider" />
        <Button variant={gizmo === "move" ? "primary" : "subtle"} onClick={() => setGizmo("move")} title={`${t("Move")} (G)`}>
          {t("Move")}
        </Button>
        <Button variant={gizmo === "resize" ? "primary" : "subtle"} onClick={() => setGizmo("resize")} title={`${t("Resize")} (S)`}>
          {t("Resize")}
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
        <Button variant="ghost" disabled={readOnly} onClick={() => void addSlot()}>
          {t("Add Texture Slot…")}
        </Button>
        <span className="content-spacer" />
        <IconButton size={26} title={`${t("View Code")} (F7)`} onClick={viewCode}>
          <Icon name="code" size={15} />
        </IconButton>
      </div>
      <div className="content-body">
        <div className="content-outliner">
          <div className="content-pane-header">
            <span>{t("Elements")}</span>
            <span className="content-spacer" />
            <IconButton size={22} title={t("Add Element")} disabled={readOnly || !!resolved.sprite} onClick={addElement}>
              <Icon name="plus" size={14} />
            </IconButton>
            <IconButton size={22} title={`${t("Duplicate")} (Ctrl+D)`} disabled={readOnly || sel === null} onClick={duplicateElement}>
              <Icon name="split" size={14} />
            </IconButton>
            <IconButton size={22} title={t("Move Up")} disabled={readOnly || sel === null || sel === 0} onClick={() => moveElement(-1)}>
              <Icon name="arrowUp" size={14} />
            </IconButton>
            <IconButton size={22} title={t("Move Down")} disabled={readOnly || sel === null || sel === elements.length - 1} onClick={() => moveElement(1)}>
              <Icon name="arrowDown" size={14} />
            </IconButton>
            <IconButton size={22} title={`${t("Delete")} (Del)`} disabled={readOnly || sel === null} onClick={deleteElement}>
              <Icon name="trash" size={14} />
            </IconButton>
          </div>
          {resolved.sprite ? (
            <p className="content-note">{t("An item sprite: the layer textures, extruded. Set Parent to empty and add elements for a 3D item.")}</p>
          ) : (
            <>
              {!resolved.own && elements.length > 0 && (
                <p className="content-note">
                  {t("These elements come from {parent}. Editing one copies them into this model.", { parent: model?.parent ?? "" })}
                </p>
              )}
              <ul className="content-elements" role="listbox">
                {elements.map((el, i) => (
                  <li
                    key={i}
                    role="option"
                    aria-selected={i === sel}
                    className={i === sel ? "selected" : undefined}
                    onClick={() => onSelect(i, null)}
                  >
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
                    <button
                      key={d}
                      type="button"
                      className={`content-face${face === d ? " selected" : ""}${selEl.faces[d] ? "" : " off"}`}
                      onClick={() => onSelect(sel, d)}
                    >
                      {t(d)}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <Viewport
          className="content-viewport"
          parts={parts}
          images={images}
          selected={sel}
          selectedFace={face}
          onSelect={onSelect}
          onTransform={readOnly ? undefined : onTransform}
          gizmo={gizmo}
          shading={shading}
          showGrid={grid}
          renderLayer={file.block?.render_layer}
          display={display}
          viewRequest={viewRequest}
        />
        <div className="content-side">
          <PropertyGrid
            className="content-properties"
            objectName={selEl ? (selEl.name ?? `${t("Element")} ${(sel ?? 0) + 1}`) : (file.name ?? path.split(/[\\/]/).pop())}
            objectType={selEl ? t("Element") : kind === "block" ? t("Block") : t("Item")}
            objectKey={`${effectiveKey}:${sel ?? "-"}:${face ?? "-"}`}
            properties={properties}
            persistKey="yog.content.properties"
          />
          {faceData && face && selEl && (
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
                image={faceTexture ? images[faceTexture] : undefined}
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
