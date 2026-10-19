// The model edited: its parent, textures, display, and the selected element and face.

import { PROPERTY_KIND, type PropertyDescriptor, t } from "substrate-platform-ui";
import { ANGLES, AXES, type Axis, BLOCK_CENTER, BLOCK_PIXELS, type Dir, DIRS, DISPLAY_LIMITS, type DisplayTransform, type Element, ELEMENT_MAX, ELEMENT_MIN, GUI_LIGHTS, type Model, TEMPLATES, type Uv, UV_ROTATIONS, type Vec3 } from "../../../content/model";
import { kind as KIND } from "../../../data/yogIds.generated";
import { ensureModel } from "../contentModel";
import { vecText } from "../fieldText";
import type { PropertiesContext } from "./context";

/** The default rotation axis. */
const DEFAULT_AXIS: Axis = "y";
/** The slot a new face uses when the model has none. */
const FIRST_SLOT = "0";
const XYZ = 3;
const UV_COORDS = 4;

/** The model edited: its parent, textures, display, and the selected element and face. */
export function modelRows(ctx: PropertiesContext, out: PropertyDescriptor[]): void {
  modelOwnRows(ctx, out);
  textureRows(ctx, out);
  displayRows(ctx, out);
  const { selEl, sel } = ctx;
  if (!selEl || sel === null) return;
  elementRows(ctx, out, selEl, sel);
  faceToggleRows(ctx, out, selEl, sel);
  faceRows(ctx, out, selEl, sel);
}

/** Edits the model shown (made if it's inherited). */
function modelSetter({ update, effectiveKey }: PropertiesContext) {
  return (edit: (m: Model) => void) => update((d) => edit(ensureModel(d, effectiveKey)));
}

/** Edits element `sel`. */
function elementSetter({ editElements }: PropertiesContext, sel: number) {
  return (edit: (e: Element) => void) => editElements((els) => edit(els[sel]));
}

/** The model's own: parent, ambient occlusion, GUI light. */
function modelOwnRows(ctx: PropertiesContext, out: PropertyDescriptor[]) {
  const { model, modelKind, resolved, text, flag, choice } = ctx;
  const mc = t("Model");
  const setM = modelSetter(ctx);
  out.push(
    text("parent", t("Parent"), mc, model?.parent, (v) => setM((m) => void (m.parent = v)), {
      suggestions: TEMPLATES.filter((x) => (modelKind === KIND.ITEM ? true : !x.sprite)).map((x) => x.name),
      description: t("A template (cube_all, cube_column, …, generated, handheld for items) or any model id. Empty: the model's own elements."),
    }),
  );
  if (resolved.sprite) return;
  out.push(
    flag("ambient_occlusion", t("Ambient Occlusion"), mc, model?.ambient_occlusion, (v) => setM((m) => void (m.ambient_occlusion = v)), true),
    choice("gui_light", t("GUI Light"), mc, model?.gui_light, GUI_LIGHTS, (v) => setM((m) => void (m.gui_light = v as Model["gui_light"]))),
  );
}

/** Each texture slot: its own value, or the inherited one shown dimmed. */
function textureRows(ctx: PropertiesContext, out: PropertyDescriptor[]) {
  const { model, resolved, shownImages, choices } = ctx;
  const tc = t("Textures");
  const setM = modelSetter(ctx);
  for (const slot of resolved.slots) {
    const own = model?.textures?.[slot];
    const shown = resolved.textures[slot];
    out.push({
      id: `tex:${slot}`,
      name: slot,
      category: tc,
      value: own ?? "",
      displayValue: own ?? (shown ? `${shown} ${t("(inherited)")}` : ""),
      image: shown ? shownImages[shown]?.url : undefined,
      kind: PROPERTY_KIND.string,
      suggestions: [...resolved.slots.filter((s) => s !== slot).map((s) => `#${s}`), ...choices.textures],
      readOnly: ctx.readOnly,
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
}

/** The display transform previewed: rotation, translation, scale. */
function displayRows(ctx: PropertiesContext, out: PropertyDescriptor[]) {
  const { displaySlot, resolved, vec } = ctx;
  if (!displaySlot) return;
  const dc = `${t("Display")}: ${displaySlot}`;
  const cur = resolved.display[displaySlot] ?? {};
  const setM = modelSetter(ctx);
  const setD = (k: keyof DisplayTransform, v: number[] | undefined) =>
    setM((m) => {
      m.display ??= {};
      const tr = { ...cur, ...(m.display[displaySlot] ?? {}) };
      if (v) tr[k] = v as Vec3;
      else delete tr[k];
      m.display[displaySlot] = tr;
    });
  const { rotation, translation, scale } = DISPLAY_LIMITS;
  out.push(
    vec("d.rotation", t("Rotation"), dc, cur.rotation, XYZ, (v) => setD("rotation", v), rotation[0], rotation[1]),
    vec("d.translation", t("Translation"), dc, cur.translation, XYZ, (v) => setD("translation", v), translation[0], translation[1]),
    vec("d.scale", t("Scale"), dc, cur.scale, XYZ, (v) => setD("scale", v), scale[0], scale[1]),
  );
}

/** The selected element: name, bounds, rotation, rescale, shade. */
function elementRows(ctx: PropertiesContext, out: PropertyDescriptor[], selEl: Element, sel: number) {
  const { text, vec, choice, flag } = ctx;
  const ro = ctx.readOnly;
  const ec = t("Element");
  const setE = elementSetter(ctx, sel);
  const r = selEl.rotation;
  out.push(
    text("e.name", t("Name"), ec, selEl.name, (v) => setE((e) => void (e.name = v))),
    vec("e.from", t("From"), ec, selEl.from, XYZ, (v) => v && setE((e) => void (e.from = v as Vec3)), ELEMENT_MIN, ELEMENT_MAX, false),
    vec("e.to", t("To"), ec, selEl.to, XYZ, (v) => v && setE((e) => void (e.to = v as Vec3)), ELEMENT_MIN, ELEMENT_MAX, false),
    choice("e.axis", t("Rotation Axis"), ec, r?.axis ?? DEFAULT_AXIS, AXES, (v) =>
      setE((e) => void (e.rotation = { origin: [...BLOCK_CENTER], angle: 0, ...(e.rotation ?? {}), axis: (v ?? DEFAULT_AXIS) as Axis })),
    ),
    {
      id: "e.angle",
      name: t("Rotation Angle"),
      category: ec,
      value: String(r?.angle ?? 0),
      kind: PROPERTY_KIND.enum,
      options: ANGLES.map(String),
      readOnly: ro,
      description: t("Minecraft allows one axis and -45, -22.5, 0, 22.5 or 45 degrees."),
      onCommit: (v) =>
        setE((e) => {
          const angle = Number(v);
          if (!angle && (!e.rotation?.origin || vecText(e.rotation.origin) === vecText(BLOCK_CENTER))) delete e.rotation;
          else e.rotation = { axis: DEFAULT_AXIS, origin: [...BLOCK_CENTER], ...(e.rotation ?? {}), angle };
        }),
    },
    vec("e.origin", t("Rotation Origin"), ec, r?.origin ?? BLOCK_CENTER, XYZ, (v) => setE((e) => void (e.rotation = { axis: DEFAULT_AXIS, angle: 0, ...(e.rotation ?? {}), origin: (v ?? [...BLOCK_CENTER]) as Vec3 })), ELEMENT_MIN, ELEMENT_MAX),
    flag("e.rescale", t("Rescale"), ec, r?.rescale, (v) => setE((e) => void (e.rotation && (e.rotation.rescale = v))), false, { readOnly: ro || !r?.angle }),
    flag("e.shade", t("Shade"), ec, selEl.shade, (v) => setE((e) => void (e.shade = v)), true),
  );
}

/** Which of the selected element's faces it has. */
function faceToggleRows(ctx: PropertiesContext, out: PropertyDescriptor[], selEl: Element, sel: number) {
  const fc = t("Faces");
  const setE = elementSetter(ctx, sel);
  for (const d of DIRS) {
    out.push({
      id: `e.face.${d}`,
      name: t(d),
      category: fc,
      value: !!selEl.faces[d],
      kind: PROPERTY_KIND.bool,
      readOnly: ctx.readOnly,
      onCommit: (v) =>
        setE((e) => {
          if (v) e.faces[d] = { texture: `#${ctx.resolved.slots[0] ?? FIRST_SLOT}` };
          else delete e.faces[d];
        }),
    });
  }
}

/** The picked face: its texture, UV and its rotation, cull face, tint. */
function faceRows(ctx: PropertiesContext, out: PropertyDescriptor[], selEl: Element, sel: number) {
  const { face, resolved, choice, vec, num } = ctx;
  const f = face ? selEl.faces[face] : undefined;
  if (!face || !f) return;
  const c = `${t("Face")}: ${t(face)}`;
  const setE = elementSetter(ctx, sel);
  const setF = (edit: (x: NonNullable<Element["faces"][Dir]>) => void) =>
    setE((e) => {
      const target = e.faces[face];
      if (target) edit(target);
    });
  out.push(
    choice("f.texture", t("Texture"), c, f.texture.replace(/^#/, ""), resolved.slots, (v) => v && setF((x) => void (x.texture = `#${v}`))),
    vec("f.uv", t("UV"), c, f.uv, UV_COORDS, (v) => setF((x) => void (x.uv = v as Uv | undefined)), 0, BLOCK_PIXELS),
    choice("f.rotation", t("UV Rotation"), c, String(f.rotation ?? 0), UV_ROTATIONS.map(String), (v) => setF((x) => void (x.rotation = v && v !== "0" ? Number(v) : undefined))),
    choice("f.cullface", t("Cull Face"), c, f.cullface, DIRS, (v) => setF((x) => void (x.cullface = v as Dir | undefined)), {
      description: t("Not drawn when a full block is on that side."),
    }),
    num("f.tint", t("Tint Index"), c, f.tint, (v) => setF((x) => void (x.tint = v)), { min: 0, int: true }),
  );
}
