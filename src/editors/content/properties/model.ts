// The model edited: its parent, textures, display, and the selected element and face.

import { type PropertyDescriptor, t } from "substrate-platform-ui";
import { ANGLES, type Axis, type Dir, DIRS, type DisplayTransform, type Element, type Model, TEMPLATES, type Uv, type Vec3 } from "../../../content/model";
import { ensureModel } from "../contentModel";
import { vecText } from "../fieldText";
import type { PropertiesContext } from "./context";
import { kind as KIND } from "../../../data/yogIds.generated";

/** The model edited: its parent, textures, display, and the selected element and face. */
export function modelRows(ctx: PropertiesContext, out: PropertyDescriptor[]): void {
  const { update, choices, effectiveKey, resolved, displaySlot, editElements, face, model, modelKind, sel, selEl, shownImages, num, text, choice, flag, vec } = ctx;
  const ro = ctx.readOnly;
  // The model.
  const mc = t("Model");
  const setM = (edit: (m: Model) => void) => update((d) => edit(ensureModel(d, effectiveKey)));
  out.push(
    text("parent", t("Parent"), mc, model?.parent, (v) => setM((m) => void (m.parent = v)), {
      suggestions: TEMPLATES.filter((x) => (modelKind === KIND.ITEM ? true : !x.sprite)).map((x) => x.name),
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
}
