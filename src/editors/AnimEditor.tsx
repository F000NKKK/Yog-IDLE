import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Icon, KeyHints, Toolbar, ToolbarButton, ToolbarCheck, ToolbarGroup, ToolbarModes, ToolbarSelect, eventKey, usePropertyContext, useT, type EditorProps, type KeyHint, type PropertyDescriptor } from "substrate-platform-ui";
import { ModelViewport, type GizmoMode } from "../body/ModelViewport";
import { useBodyTexture } from "../body/useBody";
import { useFileText } from "../body/useFileText";
import { useContentRefs } from "../data/contentRefs";
import {
  addBoneTrack,
  addClip,
  CHANNELS,
  cloneDoc,
  EASES,
  freeClipName,
  LOOPS,
  moveKey,
  parseAnim,
  patchAnim,
  removeBoneTrack,
  removeKey,
  renameClip,
  restOf,
  samplePose,
  sampleTrack,
  setClipField,
  setKey,
  VANILLA_PARTS,
  type AnimDoc,
  type Channel,
  type Clip,
  type Ease,
  type Key,
  type Loop,
} from "../body/yanim";
import { blankModel, parseModel, type Vec3 } from "../body/ymodel";
import { inspectorRows } from "./inspector";
import "./designers.css";
import "./AnimEditor.css";
import { formats } from "../yogFileTypes";

export const ANIM_SOURCE_VIEW = "yog.yanim.source";

/** Each channel's name as the timeline shows it. */
const CHANNEL_LABELS: Record<Channel, string> = { rotation: "Turn", position: "Move", scale: "Scale" };
const EASE_LABELS: Record<Ease, string> = { linear: "Linear", smooth: "Smooth", step: "Step" };
const LOOP_LABELS: Record<Loop, string> = { once: "Once", hold: "Hold", loop: "Loop" };

/** Keys snap to this many seconds (Shift: free). */
const TIME_SNAP = 0.05;
/** Room left and right of the timeline, pixels. */
const LANE_PAD = 10;

const CONTROLS: KeyHint[] = [
  { action: "Play / pause", keys: "space" },
  { action: "Key the bone", keys: "i" },
  { action: "Delete the key", keys: "delete" },
  { action: "Move / turn / size", keys: ["g", "r", "s"] },
  { action: "Orbit", keys: "mmb" },
  { action: "Zoom", keys: "wheel" },
];

/** A picked keyframe. */
interface KeySel {
  bone: string;
  ch: Channel;
  at: string;
}

const snapTime = (t: number, free: boolean) => (free ? Math.round(t * 1000) / 1000 : Math.round(t / TIME_SNAP) * TIME_SNAP);
const fmtTime = (t: number) => `${(Math.round(t * 100) / 100).toFixed(2)} s`;

/**
 * The `.yanim` designer, a timeline as Blender's Dope Sheet: the clips in
 * the toolbar, the clip played on a model in 3D above (the gizmo poses the
 * picked bone and keys it at the playhead), each bone's turn/move/scale
 * keys on a timeline below — scrubbed, played, keys dragged in time — and
 * the clip or the picked key in Properties (its value, how it eases).
 */
export function AnimEditor({ path, content, onChange, readOnly }: EditorProps) {
  const t = useT();
  const parsed = useMemo(() => parseAnim(content), [content]);
  const clips = useMemo(() => (parsed.ok ? parsed.clips : []), [parsed]);
  const [clipName, setClipName] = useState<string | null>(null);
  const clip: Clip | null = clips.find((c) => c.name === clipName) ?? clips[0] ?? null;
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [bone, setBone] = useState<string | null>(null);
  const [keySel, setKeySel] = useState<KeySel | null>(null);
  const [mode, setMode] = useState<GizmoMode>("rotate");
  const [grid, setGrid] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);

  // The model it's previewed on: picked, else the one named like the file (`wisp_anims` → `wisp`).
  const models = useContentRefs(path, formats.model.ext).own;
  const [modelPick, setModelPick] = useState<string | null>(null);
  const stem = path.split(/[\\/]/).pop()!.replace(/\.yanim$/, "");
  const modelRef = modelPick ?? models.find((m) => stem.startsWith(m.file.split(/[\\/]/).pop()!.replace(/\.ymodel$/, "")))?.id ?? models[0]?.id ?? null;
  const modelFile = models.find((m) => m.id === modelRef)?.file ?? null;
  const modelText = useFileText(modelFile);
  const model = useMemo(() => {
    try {
      return modelText !== null ? parseModel(modelText) : null;
    } catch {
      return null;
    }
  }, [modelText]);
  const texture = useBodyTexture(modelFile, model?.texture).url;
  const shown = useMemo(() => model ?? { ...blankModel(), bones: [] }, [model]);

  // ── Edits: the document changed in place, written back as a patch ──────

  const contentRef = useRef(content);
  contentRef.current = content;
  const edit = useCallback(
    (change: (doc: AnimDoc) => void) => {
      if (readOnly || !parsed.ok) return;
      const next = cloneDoc(parsed.doc);
      change(next);
      const text = patchAnim(contentRef.current, next);
      if (text !== contentRef.current) onChange(text);
    },
    [onChange, readOnly, parsed],
  );

  // ── Playback ────────────────────────────────────────────────────────────

  const length = Math.max(clip?.length ?? 1, 0.05);
  useEffect(() => {
    if (!playing || !clip) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      setTime((x) => {
        const n = x + (now - last) / 1000;
        return clip.loop === "loop" ? n % length : Math.min(n, length);
      });
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, clip, length]);
  useEffect(() => {
    if (playing && clip && clip.loop !== "loop" && time >= length) setPlaying(false);
  }, [playing, clip, time, length]);
  const pose = useMemo(() => (clip ? samplePose({ ...clip, loop: "hold" }, time) : null), [clip, time]);

  /** The value of `ch` of `b` at the playhead (the rest's when it has no keys). */
  const valueAt = useCallback(
    (b: string, ch: Channel): Vec3 => {
      const keys = clip?.bones.find((x) => x.bone === b)?.tracks[ch] ?? [];
      return sampleTrack(keys, time) ?? [restOf(ch), restOf(ch), restOf(ch)];
    },
    [clip, time],
  );

  /** Keys every channel of `b` at the playhead with its current value (Blender's I). */
  const keyBone = useCallback(
    (b: string, channels: readonly Channel[] = CHANNELS) =>
      clip &&
      edit((d) => {
        for (const ch of channels) setKey(d, clip.name, b, ch, snapTime(time, true), valueAt(b, ch), "linear");
      }),
    [clip, edit, time, valueAt],
  );

  const selectedKey: Key | null = useMemo(() => {
    if (!keySel || !clip) return null;
    return clip.bones.find((b) => b.bone === keySel.bone)?.tracks[keySel.ch].find((k) => k.at === keySel.at) ?? null;
  }, [keySel, clip]);

  // Keys over the editor: Space plays, I keys, Delete removes a key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = rootRef.current;
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable;
      if (typing || !el || !el.matches(":hover")) return;
      const k = eventKey(e);
      if (k === "space") setPlaying((p) => !p);
      else if (k === "i" && bone) keyBone(bone);
      else if ((k === "delete" || k === "backspace") && keySel && clip) {
        edit((d) => removeKey(d, clip.name, keySel.bone, keySel.ch, keySel.at));
        setKeySel(null);
      } else if (k === "home") setTime(0);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bone, keyBone, keySel, clip, edit]);

  // ── Properties: the clip, the picked key ───────────────────────────────

  const properties = useMemo<PropertyDescriptor[]>(() => {
    if (!clip) return [];
    const ro = !!readOnly;
    const { num } = inspectorRows(t, ro, path);
    const out: PropertyDescriptor[] = [];
    const cc = t("Clip");
    out.push(
      {
        id: "clip.name",
        name: t("Name"),
        category: cc,
        value: clip.name,
        kind: "string",
        readOnly: ro,
        validate: (v) => (!String(v).trim() ? t("A name is needed") : String(v) !== clip.name && clips.some((c) => c.name === String(v)) ? t("Another clip has this name") : null),
        onCommit: (v) => {
          const name = String(v).trim();
          edit((d) => renameClip(d, clip.name, name));
          setClipName(name);
        },
      },
      num("clip.length", t("Length (s)"), cc, clip.length, (v) => v !== undefined && edit((d) => setClipField(d, clip.name, "length", v)), { min: 0, description: t("How long it runs, seconds.") }),
      {
        id: "clip.loop",
        name: t("At the End"),
        category: cc,
        value: clip.loop,
        kind: "enum",
        options: LOOPS,
        optionLabel: (o) => t(LOOP_LABELS[o as Loop]),
        readOnly: ro,
        description: t("Once: back to rest; Hold: stays at its last frame; Loop: starts over."),
        onCommit: (v) => edit((d) => setClipField(d, clip.name, "loop", v as Loop)),
      },
    );
    if (keySel && selectedKey) {
      const kc = t("Key");
      out.push(
        num("key.time", t("Time (s)"), kc, selectedKey.time, (v) => {
          if (v === undefined) return;
          edit((d) => moveKey(d, clip.name, keySel.bone, keySel.ch, keySel.at, v));
          setKeySel({ ...keySel, at: String(Math.round(v * 10000) / 10000) });
        }, { min: 0 }),
        {
          id: "key.value",
          name: t(CHANNEL_LABELS[keySel.ch]),
          category: kc,
          value: selectedKey.value,
          step: keySel.ch === "rotation" ? 2.5 : keySel.ch === "position" ? 0.5 : 0.05,
          readOnly: ro,
          description: keySel.ch === "rotation" ? t("Degrees on top of the rest turn.") : keySel.ch === "position" ? t("Pixels on top of the rest place.") : t("A factor: 1 is its size."),
          onCommit: (v) => edit((d) => setKey(d, clip.name, keySel.bone, keySel.ch, selectedKey.time, [...(v as number[])] as Vec3, selectedKey.ease)),
        },
        {
          id: "key.ease",
          name: t("Ease"),
          category: kc,
          value: selectedKey.ease,
          kind: "enum",
          options: EASES,
          optionLabel: (o) => t(EASE_LABELS[o as Ease]),
          readOnly: ro,
          description: t("How it goes on to the next key: Linear evenly, Smooth through its neighbours, Step jumps at the next key."),
          onCommit: (v) => edit((d) => setKey(d, clip.name, keySel.bone, keySel.ch, selectedKey.time, selectedKey.value, v as Ease)),
        },
      );
    }
    return out;
  }, [clip, clips, keySel, selectedKey, readOnly, t, path, edit]);

  usePropertyContext(
    path,
    clip
      ? {
          order: "declared",
          objectName: keySel ? `${keySel.bone} · ${fmtTime(selectedKey?.time ?? 0)}` : clip.name,
          objectType: keySel ? t("Key") : t("Clip"),
          objectKey: keySel ? JSON.stringify(keySel) : `clip:${clip.name}`,
          properties,
          footer: <KeyHints hints={CONTROLS} />,
        }
      : null,
  );

  if (!parsed.ok) return <div className="designer-error">{t("This file has a mistake: {error}", { error: parsed.error })}</div>;

  const newClip = () =>
    edit((d) => {
      const name = freeClipName(d, "clip");
      addClip(d, name);
      setClipName(name);
    });
  const deleteClip = () =>
    clip &&
    edit((d) => {
      d.delete(clip.name);
      setClipName(null);
      setKeySel(null);
    });
  const trackedBones = clip?.bones.map((b) => b.bone) ?? [];
  const addable = [...shown.bones.map((b) => b.name), ...VANILLA_PARTS].filter((n, i, all) => !trackedBones.includes(n) && all.indexOf(n) === i);

  return (
    <div className="designer anim-editor" ref={rootRef}>
      <Toolbar>
        <ToolbarGroup>
          <ToolbarSelect label={t("Clip")} value={clip?.name ?? ""} options={clips.map((c) => ({ value: c.name, label: c.name }))} disabled={!clips.length} onChange={(v) => (setClipName(v), setKeySel(null), setTime(0))} />
          <ToolbarButton icon="plus" label="New Clip" disabled={readOnly} onClick={newClip} />
          <ToolbarButton icon="trash" label="Delete Clip" disabled={readOnly || !clip} onClick={deleteClip} />
        </ToolbarGroup>
        <ToolbarGroup>
          <ToolbarButton icon="skipBack" label="To the Start" shortcut="home" disabled={!clip} onClick={() => setTime(0)} />
          <ToolbarButton icon={playing ? "pause" : "play"} label={playing ? "Pause" : "Play"} shortcut="space" disabled={!clip} onClick={() => setPlaying((p) => !p)} />
          <span className="anim-time">{fmtTime(time)}</span>
        </ToolbarGroup>
        <ToolbarGroup>
          <ToolbarModes
            value={mode}
            onChange={setMode}
            modes={[
              { value: "translate", label: "Move", icon: "arrowUp", shortcut: "g" },
              { value: "rotate", label: "Turn", icon: "sync", shortcut: "r" },
              { value: "scale", label: "Size", icon: "expand", shortcut: "s" },
            ]}
          />
          <ToolbarButton icon="yogAnim" label="Key the Bone" shortcut="i" showLabel disabled={readOnly || !bone || !clip} onClick={() => bone && keyBone(bone)} />
        </ToolbarGroup>
        <ToolbarGroup>
          <ToolbarSelect label={t("Model")} value={modelRef ?? ""} options={models.map((m) => ({ value: m.id, label: m.id }))} disabled={!models.length} onChange={setModelPick} />
          <ToolbarCheck label="Grid" checked={grid} onChange={setGrid} />
        </ToolbarGroup>
      </Toolbar>
      <div className="designer-body anim-body">
        <div className="anim-view">
          <ModelViewport
            style={{ position: "absolute", inset: 0 }}
            model={shown}
            texture={texture}
            selection={bone ? { kind: "bone", bone } : null}
            onSelect={(s) => setBone(s && "bone" in s ? s.bone : null)}
            mode={mode}
            onMode={setMode}
            snap={{ move: 0.5, turn: 2.5 }}
            showGrid={grid}
            pose={pose}
            editPose={!playing && !readOnly}
            onBone={(b, pivot, rotation, scale) => {
              const rest = shown.bones.find((x) => x.name === b);
              if (!rest || !clip) return;
              const at = snapTime(time, true);
              edit((d) => {
                if (mode === "rotate") setKey(d, clip.name, b, "rotation", at, [0, 1, 2].map((i) => Math.round((rotation[i] - rest.rotation[i]) * 100) / 100) as Vec3, "linear");
                else if (mode === "translate") setKey(d, clip.name, b, "position", at, [0, 1, 2].map((i) => Math.round((pivot[i] - rest.pivot[i]) * 100) / 100) as Vec3, "linear");
                else setKey(d, clip.name, b, "scale", at, scale, "linear");
              });
            }}
            onCube={() => {}}
            onLocator={() => {}}
          />
          {!model && <div className="designer-note">{t("No .ymodel in the mod to show the clip on.")}</div>}
        </div>
        {clip ? (
          <Timeline
            clip={clip}
            length={length}
            time={time}
            readOnly={!!readOnly}
            bone={bone}
            keySel={keySel}
            addable={addable}
            onTime={(x) => (setPlaying(false), setTime(x))}
            onBone={setBone}
            onKey={(k) => (setKeySel(k), k && setBone(k.bone))}
            onMoveKey={(k, to) => {
              edit((d) => moveKey(d, clip.name, k.bone, k.ch, k.at, to));
              setKeySel({ ...k, at: String(Math.round(to * 10000) / 10000) });
            }}
            onAddKey={(b, ch, at) => edit((d) => setKey(d, clip.name, b, ch, at, sampleTrack(clip.bones.find((x) => x.bone === b)?.tracks[ch] ?? [], at) ?? [restOf(ch), restOf(ch), restOf(ch)], "linear"))}
            onAddTrack={(b) => (edit((d) => addBoneTrack(d, clip.name, b)), setBone(b))}
            onRemoveTrack={(b) => edit((d) => removeBoneTrack(d, clip.name, b))}
          />
        ) : (
          <div className="anim-empty">
            {t("No clips yet.")} {!readOnly && <Button variant="ghost" onClick={newClip}>{t("New Clip")}</Button>}
          </div>
        )}
      </div>
    </div>
  );
}

interface TimelineProps {
  clip: Clip;
  length: number;
  time: number;
  readOnly: boolean;
  bone: string | null;
  keySel: KeySel | null;
  addable: string[];
  onTime: (t: number) => void;
  onBone: (b: string) => void;
  onKey: (k: KeySel | null) => void;
  onMoveKey: (k: KeySel, to: number) => void;
  onAddKey: (bone: string, ch: Channel, at: number) => void;
  onAddTrack: (bone: string) => void;
  onRemoveTrack: (bone: string) => void;
}

/** The clip's keys by bone and channel against time: a ruler to scrub, keys to pick and drag. */
function Timeline({ clip, length, time, readOnly, bone, keySel, addable, onTime, onBone, onKey, onMoveKey, onAddKey, onAddTrack, onRemoveTrack }: TimelineProps) {
  const t = useT();
  const laneRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);
  const [drag, setDrag] = useState<{ key: KeySel; to: number } | null>(null);
  const [adding, setAdding] = useState("");
  useEffect(() => {
    const el = laneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const span = Math.max(width - LANE_PAD * 2, 1);
  const x = (s: number) => LANE_PAD + (s / length) * span;
  const timeOf = (clientX: number, free: boolean) => {
    const r = laneRef.current!.getBoundingClientRect();
    return Math.min(Math.max(snapTime(((clientX - r.left - LANE_PAD) / span) * length, free), 0), length);
  };

  const scrub = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    onTime(timeOf(e.clientX, true));
    const move = (ev: PointerEvent) => onTime(timeOf(ev.clientX, true));
    const up = () => (el.removeEventListener("pointermove", move), el.removeEventListener("pointerup", up));
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const grab = (e: ReactPointerEvent, key: KeySel, from: number) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    onKey(key);
    if (readOnly) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let to = from;
    const move = (ev: PointerEvent) => {
      to = timeOf(ev.clientX, ev.shiftKey);
      setDrag({ key, to });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      setDrag(null);
      if (Math.abs(to - from) > 1e-4) onMoveKey(key, to);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  // Ruler ticks: a step that leaves room for their labels.
  const step = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10].find((s) => (s / length) * span >= 48) ?? 10;
  const ticks: number[] = [];
  for (let s = 0; s <= length + 1e-6; s += step) ticks.push(Math.round(s * 1000) / 1000);

  const diamonds = (b: string, ch: Channel | null, keys: Key[]) =>
    keys.map((k) => {
      const sel: KeySel = { bone: b, ch: ch ?? "rotation", at: k.at };
      const picked = !!keySel && keySel.bone === b && keySel.at === k.at && (ch === null || keySel.ch === ch);
      const dragging = drag && ch && drag.key.bone === b && drag.key.ch === ch && drag.key.at === k.at;
      return (
        <span
          key={`${ch}:${k.at}`}
          className={`anim-key ease-${k.ease}${picked ? " is-picked" : ""}${ch === null ? " is-summary" : ""}`}
          style={{ left: x(dragging ? drag.to : k.time) }}
          title={`${fmtTime(k.time)} — ${k.value.join(", ")}`}
          onPointerDown={ch ? (e) => grab(e, sel, k.time) : (e) => (e.stopPropagation(), onBone(b), onTime(k.time))}
        />
      );
    });

  return (
    <div className="anim-timeline">
      <div className="anim-heads">
        <div className="anim-ruler-head">{t("Bones")}</div>
        {clip.bones.map((b) => (
          <div key={b.bone} className="anim-group">
            <div className={`anim-head is-bone${bone === b.bone ? " is-picked" : ""}`} onClick={() => onBone(b.bone)}>
              <span className="anim-head-name">{b.bone}</span>
              {!readOnly && (
                <button className="anim-head-remove" title={t("Remove the Track")} aria-label={t("Remove the Track")} onClick={(e) => (e.stopPropagation(), onRemoveTrack(b.bone))}>
                  <Icon name="trash" size={11} />
                </button>
              )}
            </div>
            {CHANNELS.map((ch) => (
              <div key={ch} className="anim-head is-channel">
                {t(CHANNEL_LABELS[ch])}
              </div>
            ))}
          </div>
        ))}
        {!readOnly && addable.length > 0 && (
          <select className="anim-add" value={adding} onChange={(e) => (onAddTrack(e.target.value), setAdding(""))}>
            <option value="">{t("Add a bone…")}</option>
            {addable.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="anim-lanes" ref={laneRef}>
        <div className="anim-ruler" onPointerDown={scrub}>
          {ticks.map((s) => (
            <span key={s} className="anim-tick" style={{ left: x(s) }}>
              {s}
            </span>
          ))}
        </div>
        {clip.bones.map((b) => {
          const all = CHANNELS.flatMap((ch) => b.tracks[ch]).filter((k, i, ks) => ks.findIndex((o) => Math.abs(o.time - k.time) < 1e-4) === i);
          return (
            <div key={b.bone} className="anim-group">
              <div className={`anim-lane is-bone${bone === b.bone ? " is-picked" : ""}`} onPointerDown={scrub}>
                {diamonds(b.bone, null, all)}
              </div>
              {CHANNELS.map((ch) => (
                <div
                  key={ch}
                  className="anim-lane is-channel"
                  onPointerDown={(e) => (onKey(null), scrub(e))}
                  onDoubleClick={(e) => !readOnly && onAddKey(b.bone, ch, timeOf(e.clientX, e.shiftKey))}
                >
                  {diamonds(b.bone, ch, b.tracks[ch])}
                </div>
              ))}
            </div>
          );
        })}
        <div className="anim-end" style={{ left: x(length) }} />
        <div className="anim-playhead" style={{ left: x(Math.min(time, length)) }} />
      </div>
    </div>
  );
}
