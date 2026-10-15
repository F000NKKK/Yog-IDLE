import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FormField, FormSection, Icon, IconButton, SelectField, useT, type EditorProps } from "substrate-platform-ui";
import { ModelViewport, type GizmoMode, type Selection } from "../body/ModelViewport";
import {
  blankModel,
  boxUvRects,
  clone,
  freeName,
  isAncestor,
  mirroredBone,
  ordered,
  parseModel,
  removeBone,
  renameBone,
  serializeModel,
  type Bone,
  type ModelFile,
  type Vec3,
} from "../body/ymodel";
import "./ModelEditor.css";

export const MODEL_SOURCE_VIEW = "yog.ymodel.source";

/** Snap steps: pixels moved, degrees turned. */
const SNAPS = [
  { id: "1", move: 1, turn: 7.5 },
  { id: "0.5", move: 0.5, turn: 2.5 },
  { id: "0.25", move: 0.25, turn: 1 },
  { id: "off", move: 0, turn: 0 },
] as const;

interface LoadedTexture {
  url: string;
}

/**
 * The `.ymodel` designer — a body model as Blockbench's Modded Entity shows
 * one: the bones in a tree on the left, the model in 3D in the middle (G/R/S
 * move, turn, size with the gizmo; Blender's camera), the selected bone,
 * cube or locator on the right with its box-UV on the texture.
 */
export function ModelEditor({ path, content, onChange, readOnly, contentVersion }: EditorProps) {
  const t = useT();
  const [model, setModel] = useState<ModelFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [mode, setMode] = useState<GizmoMode>("translate");
  const [snap, setSnap] = useState<(typeof SNAPS)[number]["id"]>("1");
  const [grid, setGrid] = useState(true);
  const [texture, setTexture] = useState<string | null>(null);
  const [textureError, setTextureError] = useState<string | null>(null);
  const undo = useRef<string[]>([]);
  const redo = useRef<string[]>([]);
  const lastText = useRef(content);

  // The document: read at mount and when the file changed under us.
  useEffect(() => {
    try {
      setModel(content.trim() ? parseModel(content) : blankModel());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    lastText.current = content;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentVersion]);

  const write = useCallback(
    (next: ModelFile, record = true) => {
      if (readOnly) return;
      const text = serializeModel(next);
      if (text === lastText.current) return;
      if (record) {
        undo.current.push(lastText.current);
        redo.current = [];
      }
      lastText.current = text;
      setModel(next);
      onChange(text);
    },
    [onChange, readOnly],
  );

  const edit = (change: (m: ModelFile) => void) => {
    if (!model) return;
    const next = clone(model);
    change(next);
    write(next);
  };

  const step = (from: MutableRefObject<string[]>, to: MutableRefObject<string[]>) => {
    const text = from.current.pop();
    if (text === undefined) return;
    to.current.push(lastText.current);
    lastText.current = text;
    try {
      setModel(parseModel(text));
    } catch {
      /* the text was ours: it parses */
    }
    onChange(text);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || readOnly) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) step(undo, redo);
      else if (k === "y" || (k === "z" && e.shiftKey)) step(redo, undo);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The texture, as the format names it.
  useEffect(() => {
    if (!model?.texture) {
      setTexture(null);
      setTextureError(null);
      return;
    }
    let live = true;
    invoke<LoadedTexture>("body_texture", { path, texture: model.texture })
      .then((tx) => live && (setTexture(tx.url), setTextureError(null)))
      .catch((e) => live && (setTexture(null), setTextureError(String(e))));
    return () => {
      live = false;
    };
  }, [path, model?.texture]);

  const snapStep = SNAPS.find((s) => s.id === snap) ?? SNAPS[0];
  const bone = model && selection ? model.bones.find((b) => b.name === selection.bone) ?? null : null;

  // ── Editing actions ─────────────────────────────────────────────────────

  const addBone = () =>
    edit((m) => {
      const name = freeName(m, "bone");
      m.bones.push({ name, parent: bone?.name ?? null, pivot: [0, 0, 0], rotation: [0, 0, 0], cubes: [], locators: {} });
      setSelection({ kind: "bone", bone: name });
    });
  const addCube = () => {
    if (!model) return;
    edit((m) => {
      let target = bone ? m.bones.find((b) => b.name === bone.name) : m.bones[0];
      if (!target) {
        target = { name: "root", parent: null, pivot: [0, 0, 0], rotation: [0, 0, 0], cubes: [], locators: {} };
        m.bones.push(target);
      }
      target.cubes.push({ origin: [-2, -2, -2], size: [4, 4, 4], uv: [0, 0], inflate: 0, mirror: false });
      setSelection({ kind: "cube", bone: target.name, cube: target.cubes.length - 1 });
    });
  };
  const addLocator = () =>
    bone &&
    edit((m) => {
      const b = m.bones.find((x) => x.name === bone.name)!;
      let name = "locator";
      for (let i = 2; name in b.locators; i++) name = `locator${i}`;
      b.locators[name] = [0, 0, 0];
      setSelection({ kind: "locator", bone: b.name, locator: name });
    });
  const remove = () =>
    selection &&
    edit((m) => {
      const b = m.bones.find((x) => x.name === selection.bone);
      if (!b) return;
      if (selection.kind === "bone") removeBone(m, b.name);
      else if (selection.kind === "cube") b.cubes.splice(selection.cube, 1);
      else delete b.locators[selection.locator];
      setSelection(null);
    });
  const duplicate = () =>
    selection &&
    edit((m) => {
      const b = m.bones.find((x) => x.name === selection.bone);
      if (!b) return;
      if (selection.kind === "cube") {
        b.cubes.push(JSON.parse(JSON.stringify(b.cubes[selection.cube])));
        setSelection({ kind: "cube", bone: b.name, cube: b.cubes.length - 1 });
      } else if (selection.kind === "bone") {
        const copy: Bone = JSON.parse(JSON.stringify(b));
        copy.name = freeName(m, b.name);
        m.bones.push(copy);
        setSelection({ kind: "bone", bone: copy.name });
      }
    });
  const mirror = () =>
    selection?.kind === "bone" &&
    edit((m) => {
      const b = m.bones.find((x) => x.name === selection.bone);
      if (!b) return;
      const copy = mirroredBone(m, b);
      m.bones.push(copy);
      setSelection({ kind: "bone", bone: copy.name });
    });

  // ── Panels ──────────────────────────────────────────────────────────────

  const toolbar = (
    <div className="model-bar">
      {(
        [
          ["translate", "Move (G)", "arrowUp"],
          ["rotate", "Turn (R)", "sync"],
          ["scale", "Size (S)", "expand"],
        ] as const
      ).map(([m, label, icon]) => (
        <IconButton key={m} title={t(label)} className={mode === m ? "active" : undefined} onClick={() => setMode(m)}>
          <Icon name={icon} />
        </IconButton>
      ))}
      <span className="model-bar-sep" />
      <IconButton title={t("Add bone")} disabled={readOnly} onClick={addBone}>
        <Icon name="plus" />
      </IconButton>
      <button type="button" className="model-bar-text" disabled={readOnly} onClick={addCube}>
        {t("+ Cube")}
      </button>
      <button type="button" className="model-bar-text" disabled={readOnly || !bone} onClick={addLocator}>
        {t("+ Locator")}
      </button>
      <button type="button" className="model-bar-text" disabled={readOnly || !selection || selection.kind === "locator"} onClick={duplicate}>
        {t("Duplicate")}
      </button>
      <button type="button" className="model-bar-text" disabled={readOnly || selection?.kind !== "bone"} onClick={mirror} title={t("A mirrored copy: left ↔ right")}>
        {t("Mirror")}
      </button>
      <IconButton title={t("Delete")} disabled={readOnly || !selection} onClick={remove}>
        <Icon name="trash" />
      </IconButton>
      <span className="model-bar-sep" />
      <label className="model-bar-label">{t("Snap")}</label>
      <SelectField
        aria-label={t("Snap")}
        value={snap}
        options={SNAPS.map((s) => ({ value: s.id, label: s.id === "off" ? t("Off") : `${s.move} px / ${s.turn}°` }))}
        onChange={(v) => setSnap(v as typeof snap)}
      />
      <label className="model-bar-check">
        <input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} /> {t("Grid")}
      </label>
    </div>
  );

  const outliner = model && (
    <div className="model-outliner" role="tree">
      {ordered(model).map((b) => {
        let depth = 0;
        for (let p = b.parent; p && depth < 32; depth++) p = model.bones.find((x) => x.name === p)?.parent ?? null;
        const pad = { paddingLeft: 8 + depth * 14 };
        return (
          <div key={b.name}>
            <div
              className={`model-row bone${selection?.kind === "bone" && selection.bone === b.name ? " selected" : ""}`}
              style={pad}
              onClick={() => setSelection({ kind: "bone", bone: b.name })}
            >
              <span className="model-row-icon">🦴</span>
              {b.name}
            </div>
            {b.cubes.map((_, i) => (
              <div
                key={`c${i}`}
                className={`model-row${selection?.kind === "cube" && selection.bone === b.name && selection.cube === i ? " selected" : ""}`}
                style={{ paddingLeft: pad.paddingLeft + 18 }}
                onClick={() => setSelection({ kind: "cube", bone: b.name, cube: i })}
              >
                <span className="model-row-icon">▣</span>
                {t("cube {n}", { n: i + 1 })}
              </div>
            ))}
            {Object.keys(b.locators).map((name) => (
              <div
                key={`l${name}`}
                className={`model-row${selection?.kind === "locator" && selection.bone === b.name && selection.locator === name ? " selected" : ""}`}
                style={{ paddingLeft: pad.paddingLeft + 18 }}
                onClick={() => setSelection({ kind: "locator", bone: b.name, locator: name })}
              >
                <span className="model-row-icon">◆</span>
                {name}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );

  const vec = (label: string, value: Vec3, set: (v: Vec3) => void, stepBy = 1) => (
    <FormField label={label}>
      <div className="model-vec">
        {value.map((n, i) => (
          <input
            key={i}
            type="number"
            step={stepBy}
            value={n}
            disabled={readOnly}
            onChange={(e) => {
              const v = [...value] as Vec3;
              v[i] = Number(e.target.value) || 0;
              set(v);
            }}
          />
        ))}
      </div>
    </FormField>
  );

  const editBone = (change: (b: Bone) => void) =>
    edit((m) => {
      const b = m.bones.find((x) => x.name === selection!.bone);
      if (b) change(b);
    });

  const inspector = model && (
    <div className="model-inspector">
      <FormSection title={t("Model")}>
        <FormField label={t("Texture")} hint={t("A path under the mod's textures/ (entity/wisp.png) or a full id")} error={textureError}>
          <input className="model-input" value={model.texture} disabled={readOnly} onChange={(e) => edit((m) => void (m.texture = e.target.value))} />
        </FormField>
        <FormField label={t("Texture size")}>
          <div className="model-vec">
            {model.textureSize.map((n, i) => (
              <input
                key={i}
                type="number"
                min={1}
                value={n}
                disabled={readOnly}
                onChange={(e) => edit((m) => void (m.textureSize[i] = Math.max(1, Number(e.target.value) || 1)))}
              />
            ))}
          </div>
        </FormField>
      </FormSection>
      {selection?.kind === "bone" && bone && (
        <FormSection title={t("Bone")}>
          <FormField label={t("Name")}>
            <input
              className="model-input"
              defaultValue={bone.name}
              key={bone.name}
              disabled={readOnly}
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (!name || name === bone.name || model.bones.some((b) => b.name === name)) return;
                edit((m) => renameBone(m, bone.name, name));
                setSelection({ kind: "bone", bone: name });
              }}
            />
          </FormField>
          <FormField label={t("Parent")} hint={t("Bones the model lacks are the vanilla model's parts — for clips, not here")}>
            <SelectField
              aria-label={t("Parent")}
              value={bone.parent ?? ""}
              options={[{ value: "", label: t("(none — the anchor)") }, ...model.bones.filter((b) => !isAncestor(model, bone.name, b.name)).map((b) => ({ value: b.name, label: b.name }))]}
              disabled={readOnly}
              onChange={(v) => editBone((b) => void (b.parent = v || null))}
            />
          </FormField>
          {vec(t("Pivot"), bone.pivot, (v) => editBone((b) => void (b.pivot = v)), 0.5)}
          {vec(t("Turn (°)"), bone.rotation, (v) => editBone((b) => void (b.rotation = v)), 2.5)}
        </FormSection>
      )}
      {selection?.kind === "cube" && bone?.cubes[selection.cube] && (() => {
        const c = bone.cubes[selection.cube];
        const editCube = (change: (cube: typeof c) => void) => editBone((b) => change(b.cubes[selection.cube]));
        return (
          <FormSection title={t("Cube")}>
            {vec(t("Origin"), c.origin, (v) => editCube((x) => void (x.origin = v)), 0.5)}
            {vec(t("Size"), c.size, (v) => editCube((x) => void (x.size = v.map((n) => Math.max(0, n)) as Vec3)))}
            <FormField label={t("UV")}>
              <div className="model-vec">
                {c.uv.map((n, i) => (
                  <input key={i} type="number" value={n} disabled={readOnly} onChange={(e) => editCube((x) => void (x.uv[i] = Number(e.target.value) || 0))} />
                ))}
              </div>
            </FormField>
            <FormField label={t("Inflate")} hint={t("Grown on every side, the UVs kept (CubeDeformation)")}>
              <input className="model-input" type="number" step={0.25} value={c.inflate} disabled={readOnly} onChange={(e) => editCube((x) => void (x.inflate = Number(e.target.value) || 0))} />
            </FormField>
            <FormField label={t("Mirror UV")}>
              <input type="checkbox" checked={c.mirror} disabled={readOnly} onChange={(e) => editCube((x) => void (x.mirror = e.target.checked))} />
            </FormField>
            <UvNet texture={texture} size={model.textureSize} rects={boxUvRects(c)} />
          </FormSection>
        );
      })()}
      {selection?.kind === "locator" && bone && selection.locator in bone.locators && (
        <FormSection title={t("Locator")}>
          <FormField label={t("Name")}>
            <input
              className="model-input"
              defaultValue={selection.locator}
              key={selection.locator}
              disabled={readOnly}
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (!name || name === selection.locator || name in bone.locators) return;
                editBone((b) => {
                  b.locators[name] = b.locators[selection.locator];
                  delete b.locators[selection.locator];
                });
                setSelection({ kind: "locator", bone: bone.name, locator: name });
              }}
            />
          </FormField>
          {vec(t("Place"), bone.locators[selection.locator], (v) => editBone((b) => void (b.locators[selection.locator] = v)), 0.5)}
        </FormSection>
      )}
      {!selection && <p className="model-hint">{t("Click a cube to pick it (again, or Alt: its bone). Middle drag orbits, Shift+middle pans, numpad 1/3/7 front/side/top.")}</p>}
    </div>
  );

  if (error) return <div className="model-error">{t("Can't read this model: {error}", { error })}</div>;
  if (!model) return null;
  return (
    <div className="model-editor">
      {toolbar}
      <div className="model-body">
        {outliner}
        <ModelViewport
          className="model-view"
          model={model}
          texture={texture}
          selection={selection}
          onSelect={setSelection}
          mode={mode}
          onMode={setMode}
          snap={snapStep}
          showGrid={grid}
          onBone={(name, pivot, rotation) =>
            edit((m) => {
              const b = m.bones.find((x) => x.name === name);
              if (b) Object.assign(b, { pivot, rotation });
            })
          }
          onCube={(name, i, origin, size) =>
            edit((m) => {
              const c = m.bones.find((x) => x.name === name)?.cubes[i];
              if (c) Object.assign(c, { origin, size });
            })
          }
          onLocator={(name, loc, at) =>
            edit((m) => {
              const b = m.bones.find((x) => x.name === name);
              if (b) b.locators[loc] = at;
            })
          }
        />
        {inspector}
      </div>
    </div>
  );
}

/** A cube's box-UV on the texture: where each of its faces takes its pixels. */
function UvNet({ texture, size, rects }: { texture: string | null; size: [number, number]; rects: ReturnType<typeof boxUvRects> }) {
  const scale = Math.max(1, Math.floor(240 / Math.max(size[0], size[1])));
  const style = useMemo(() => ({ width: size[0] * scale, height: size[1] * scale }), [size, scale]);
  return (
    <div className="model-uvnet" style={style}>
      {texture && <img src={texture} alt="" style={style} draggable={false} />}
      {rects.map((r) => (
        <div
          key={r.face}
          className={`model-uvnet-face ${r.face}`}
          title={r.face}
          style={{ left: r.x * scale, top: r.y * scale, width: Math.max(1, r.w * scale), height: Math.max(1, r.h * scale) }}
        />
      ))}
    </div>
  );
}
