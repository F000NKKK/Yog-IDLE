import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon, KeyHints, IconButton, SelectField, useKeybinding, usePropertyContext, useT, withShortcut, type EditorProps, type KeyHint, type PropertyDescriptor } from "substrate-platform-ui";
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
  type Cube,
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

/** The parent choice meaning "no parent". */
const NO_PARENT = "—";

/** The keys the viewport's hint names, as the locale writes them. */
/** How the view is driven — Properties lists it under the selection. */
const CONTROLS: KeyHint[] = [
  { action: "Pick a cube", keys: "lmb" },
  { action: "Pick its bone", keys: "alt+lmb" },
  { action: "Orbit", keys: "mmb" },
  { action: "Pan", keys: "shift+mmb" },
  { action: "Zoom", keys: "wheel" },
  { action: "Move / turn / size", keys: ["g", "r", "s"] },
  { action: "Front / side / top", keys: ["num1", "num3", "num7"] },
  { action: "From behind", keys: "ctrl+num1" },
];

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

  // Layout-independent, like every IDE shortcut: Ctrl+Z is the Z key under "я" too.
  useKeybinding("Ctrl+Z", () => step(undo, redo), { enabled: !readOnly });
  useKeybinding(["Ctrl+Y", "Ctrl+Shift+Z"], () => step(redo, undo), { enabled: !readOnly });

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
          ["translate", "Move", "g", "arrowUp"],
          ["rotate", "Turn", "r", "sync"],
          ["scale", "Size", "s", "expand"],
        ] as const
      ).map(([m, label, keys, icon]) => (
        <IconButton key={m} title={withShortcut(label, keys)} className={mode === m ? "active" : undefined} onClick={() => setMode(m)}>
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

  const editBone = (change: (b: Bone) => void) =>
    edit((m) => {
      const b = m.bones.find((x) => x.name === selection!.bone);
      if (b) change(b);
    });

  // The inspector: the model, then what's selected — one property grid.
  const properties = useMemo((): PropertyDescriptor[] => {
    if (!model) return [];
    const ro = !!readOnly;
    const out: PropertyDescriptor[] = [
      {
        id: "texture",
        category: t("Model"),
        name: t("Texture"),
        value: model.texture,
        description: t("A path under the mod's textures/ (entity/wisp.png) or a full id") + (textureError ? `\n${textureError}` : ""),
        readOnly: ro,
        onCommit: (v) => edit((m) => void (m.texture = String(v))),
      },
      {
        id: "texture_size",
        category: t("Model"),
        name: t("Texture size"),
        value: model.textureSize,
        labels: ["W", "H"],
        description: t("The texture's size in pixels, as its UVs count them"),
        readOnly: ro,
        onCommit: (v) => edit((m) => void (m.textureSize = (v as number[]).map((n) => Math.max(1, Math.round(n))) as [number, number])),
      },
    ];
    if (selection?.kind === "bone" && bone) {
      const cat = t("Bone");
      out.push(
        {
          id: "bone.name",
          category: cat,
          name: t("Name"),
          value: bone.name,
          readOnly: ro,
          validate: (v) => (!String(v).trim() ? t("A name is needed") : String(v) !== bone.name && model.bones.some((b) => b.name === String(v)) ? t("Another bone has this name") : null),
          onCommit: (v) => {
            const name = String(v).trim();
            edit((m) => renameBone(m, bone.name, name));
            setSelection({ kind: "bone", bone: name });
          },
        },
        {
          id: "bone.parent",
          category: cat,
          name: t("Parent"),
          value: bone.parent ?? NO_PARENT,
          options: [NO_PARENT, ...model.bones.filter((b) => !isAncestor(model, bone.name, b.name)).map((b) => b.name)],
          description: t("The bone it hangs on; none: the anchor (a vanilla part, the model, the entity). Bones the model lacks are the vanilla model's parts — for clips, not here"),
          readOnly: ro,
          onCommit: (v) => editBone((b) => void (b.parent = v === NO_PARENT ? null : String(v))),
        },
        { id: "bone.pivot", category: cat, name: t("Pivot"), value: bone.pivot, step: 0.5, description: t("Where it turns about, in its parent's space (PartPose offset), pixels"), readOnly: ro, onCommit: (v) => editBone((b) => void (b.pivot = [...(v as number[])] as Vec3)) },
        { id: "bone.rotation", category: cat, name: t("Turn (°)"), value: bone.rotation, step: 2.5, description: t("Its rest turn, degrees — Z, then Y, then X (as ModelPart)"), readOnly: ro, onCommit: (v) => editBone((b) => void (b.rotation = [...(v as number[])] as Vec3)) },
      );
    }
    const c = selection?.kind === "cube" ? bone?.cubes[selection.cube] : undefined;
    if (selection?.kind === "cube" && c) {
      const cat = t("Cube");
      const editCube = (change: (cube: Cube) => void) =>
        editBone((b) => {
          const cube = b.cubes[selection.cube];
          if (cube) change(cube);
        });
      out.push(
        { id: "cube.origin", category: cat, name: t("Origin"), value: c.origin, step: 0.5, description: t("Its corner, in the bone's space, pixels"), readOnly: ro, onCommit: (v) => editCube((x) => void (x.origin = [...(v as number[])] as Vec3)) },
        { id: "cube.size", category: cat, name: t("Size"), value: c.size, description: t("Its size, pixels"), readOnly: ro, onCommit: (v) => editCube((x) => void (x.size = (v as number[]).map((n) => Math.max(0, n)) as Vec3)) },
        { id: "cube.uv", category: cat, name: t("UV"), value: c.uv, labels: ["U", "V"], description: t("Where its box-UV starts on the texture (texOffs), pixels"), readOnly: ro, onCommit: (v) => editCube((x) => void (x.uv = [...(v as number[])] as [number, number])) },
        { id: "cube.inflate", category: cat, name: t("Inflate"), value: c.inflate, step: 0.25, description: t("Grown on every side, the UVs kept (CubeDeformation)"), readOnly: ro, onCommit: (v) => editCube((x) => void (x.inflate = Number(v))) },
        { id: "cube.mirror", category: cat, name: t("Mirror UV"), value: c.mirror, description: t("Its UVs mirrored left to right (mirror())"), readOnly: ro, onCommit: (v) => editCube((x) => void (x.mirror = v === true)) },
        { id: "cube.net", category: cat, name: t("Texture"), value: null, render: () => <UvNet texture={texture} size={model.textureSize} rects={boxUvRects(c)} /> },
      );
    }
    if (selection?.kind === "locator" && bone && selection.locator in bone.locators) {
      const cat = t("Locator");
      out.push(
        {
          id: "locator.name",
          category: cat,
          name: t("Name"),
          value: selection.locator,
          readOnly: ro,
          validate: (v) => (!String(v).trim() ? t("A name is needed") : String(v) !== selection.locator && String(v) in bone.locators ? t("Another locator has this name") : null),
          onCommit: (v) => {
            const name = String(v).trim();
            editBone((b) => {
              b.locators[name] = b.locators[selection.locator];
              delete b.locators[selection.locator];
            });
            setSelection({ kind: "locator", bone: bone.name, locator: name });
          },
        },
        { id: "locator.at", category: cat, name: t("Place"), value: bone.locators[selection.locator], step: 0.5, description: t("A point in the bone's space a mod follows (a camera, a hand's grip), pixels"), readOnly: ro, onCommit: (v) => editBone((b) => void (b.locators[selection.locator] = [...(v as number[])] as Vec3)) },
      );
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, selection, bone, texture, textureError, readOnly, t]);

  const objectName = selection?.kind === "cube" ? t("cube {n}", { n: selection.cube + 1 }) : selection?.kind === "locator" ? selection.locator : selection?.kind === "bone" ? selection.bone : t("Model");
  // What Properties shows while the model is active: the model, or what's picked in it.
  usePropertyContext(
    path,
    model && {
      order: "declared",
      objectName,
      objectType: selection ? t(selection.kind === "bone" ? "Bone" : selection.kind === "cube" ? "Cube" : "Locator") : undefined,
      objectKey: selection ? JSON.stringify(selection) : "model",
      properties,
      header: !selection && texture ? <UvNet texture={texture} size={model.textureSize} rects={[]} preview /> : undefined,
      footer: <KeyHints hints={CONTROLS} />,
    },
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
      </div>
    </div>
  );
}

/** A cube's box-UV on the texture, as wide as Properties: where each of its faces takes its pixels. */
function UvNet({ texture, size, rects, preview }: { texture: string | null; size: [number, number]; rects: ReturnType<typeof boxUvRects>; preview?: boolean }) {
  const pct = (n: number, of: number) => `${(n / of) * 100}%`;
  return (
    <div className={preview ? "model-uvnet is-preview" : "model-uvnet"} style={{ aspectRatio: `${size[0]} / ${size[1]}` }}>
      {texture && <img src={texture} alt="" draggable={false} />}
      {rects.map((r) => (
        <div
          key={r.face}
          className={`model-uvnet-face ${r.face}`}
          title={r.face}
          style={{ left: pct(r.x, size[0]), top: pct(r.y, size[1]), width: pct(r.w, size[0]), height: pct(r.h, size[1]) }}
        />
      ))}
    </div>
  );
}
