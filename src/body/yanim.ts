// The `.yanim` format (`yog_body::format::AnimFile`) as the timeline editor
// sees it: clips by name, each bone's rotation/position/scale keyframes by
// time (`"0.25"` seconds → `[x, y, z]` or `{ value, ease }`), sampled into a
// pose as `yog_body::anim` samples them in game.
//
// The document is kept as read — maps as `Map`s in file order (times like
// `"0"`, `"0.5"`, `"1"` would be reordered by a JS object) — and edits change
// it in place, so what the editor doesn't know (comments, `$…` keys) stays;
// `patchAnim` writes it back with only what changed rewritten.

import { DataSyntaxError, formatData, parseData, patchDataText, toOrdered } from "../data/yogData";
import type { PoseOverride } from "./ModelViewport";
import type { Vec3 } from "./ymodel";

export const EASES = ["linear", "smooth", "step"] as const;
export type Ease = (typeof EASES)[number];
export const LOOPS = ["once", "hold", "loop"] as const;
export type Loop = (typeof LOOPS)[number];
export const CHANNELS = ["rotation", "position", "scale"] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * The game's humanoid model parts (`HumanoidModel`'s part names) a clip may
 * move when a player or a disguise is drawn with the game's model; a
 * model's own bones are offered first.
 */
export const VANILLA_PARTS = ["head", "hat", "body", "right_arm", "left_arm", "right_leg", "left_leg"] as const;

export interface Key {
  time: number;
  /** As the file spells it (`"0.25"`). */
  at: string;
  value: Vec3;
  ease: Ease;
}

export interface BoneTracks {
  bone: string;
  tracks: Record<Channel, Key[]>;
}

export interface Clip {
  name: string;
  length: number;
  loop: Loop;
  bones: BoneTracks[];
}

/** The document: clip name → its map, as read. */
export type AnimDoc = Map<string, unknown>;
type M = Map<string, unknown>;

export type Parsed = { ok: true; doc: AnimDoc; clips: Clip[] } | { ok: false; error: string };

const isMap = (v: unknown): v is M => v instanceof Map;
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const vec = (v: unknown, d: number): Vec3 => (Array.isArray(v) ? [num(v[0], d), num(v[1], d), num(v[2], d)] : [d, d, d]);
/** A channel's neutral value: no turn, no move, scale 1. */
export const restOf = (c: Channel): number => (c === "scale" ? 1 : 0);

export function parseAnim(text: string): Parsed {
  let doc: unknown;
  try {
    doc = text.trim() ? toOrdered(parseData(text)) : new Map();
  } catch (e) {
    return { ok: false, error: e instanceof DataSyntaxError ? `${e.line}:${e.col}: ${e.message}` : String(e) };
  }
  if (!isMap(doc)) return { ok: false, error: "an animation file is one object: clips by name" };
  return { ok: true, doc, clips: clipsOf(doc) };
}

/** The clips `doc` holds, keys sorted by time. */
export function clipsOf(doc: AnimDoc): Clip[] {
  const out: Clip[] = [];
  for (const [name, c] of doc) {
    if (!isMap(c) || name.startsWith("$")) continue;
    const loop = c.get("loop");
    const bones: BoneTracks[] = [];
    const bm = c.get("bones");
    for (const [bone, tm] of isMap(bm) ? bm : []) {
      if (!isMap(tm)) continue;
      const tracks = { rotation: [], position: [], scale: [] } as Record<Channel, Key[]>;
      for (const ch of CHANNELS) {
        const km = tm.get(ch);
        for (const [at, k] of isMap(km) ? km : []) {
          const time = Number(at.trim());
          if (!Number.isFinite(time)) continue;
          const obj = isMap(k) ? k : null;
          const ease = obj?.get("ease");
          tracks[ch].push({ time, at, value: vec(obj ? obj.get("value") : k, restOf(ch)), ease: EASES.includes(ease as Ease) ? (ease as Ease) : "linear" });
        }
        tracks[ch].sort((a, b) => a.time - b.time);
      }
      bones.push({ bone, tracks });
    }
    out.push({ name, length: Math.max(0, num(c.get("length"))), loop: LOOPS.includes(loop as Loop) ? (loop as Loop) : "once", bones });
  }
  return out;
}

/** `text` holding `doc`: what changed rewritten, the rest — comments too — as it was. */
export function patchAnim(text: string, doc: AnimDoc): string {
  return patchDataText(text, doc, formatData);
}

/** A deep copy, maps kept `Map`s. */
export function cloneDoc<T>(v: T): T {
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, cloneDoc(x)])) as T;
  if (Array.isArray(v)) return v.map(cloneDoc) as T;
  return v;
}

// ── Editing ─────────────────────────────────────────────────────────────────

/** A time as the file writes it: seconds, at most 4 decimals. */
export const timeText = (t: number) => String(Math.round(t * 10000) / 10000);

const child = (m: M, key: string): M => {
  let c = m.get(key);
  if (!isMap(c)) {
    c = new Map();
    m.set(key, c);
  }
  return c as M;
};

/** A clip's map (made if missing). */
function clipMap(doc: AnimDoc, clip: string): M {
  return child(doc, clip);
}

/** A free clip name from `base`. */
export function freeClipName(doc: AnimDoc, base: string): string {
  if (!doc.has(base)) return base;
  for (let i = 2; ; i++) if (!doc.has(`${base}${i}`)) return `${base}${i}`;
}

export function addClip(doc: AnimDoc, name: string, length = 1): void {
  doc.set(name, new Map<string, unknown>([["length", length], ["loop", "loop"], ["bones", new Map()]]));
}

/** Renames a clip in its place. */
export function renameClip(doc: AnimDoc, from: string, to: string): void {
  if (from === to || !doc.has(from) || doc.has(to)) return;
  const entries = [...doc].map(([k, v]) => [k === from ? to : k, v] as [string, unknown]);
  doc.clear();
  for (const [k, v] of entries) doc.set(k, v);
}

export function setClipField(doc: AnimDoc, clip: string, field: "length" | "loop", value: number | Loop): void {
  const c = clipMap(doc, clip);
  if (field === "loop" && value === "once") c.delete("loop");
  else c.set(field, value);
}

/** The tracks map of `bone` in `clip` (made if missing). */
function tracksOf(doc: AnimDoc, clip: string, bone: string): M {
  return child(child(clipMap(doc, clip), "bones"), bone);
}

export function addBoneTrack(doc: AnimDoc, clip: string, bone: string): void {
  tracksOf(doc, clip, bone);
}

export function removeBoneTrack(doc: AnimDoc, clip: string, bone: string): void {
  const bones = clipMap(doc, clip).get("bones");
  if (isMap(bones)) bones.delete(bone);
}

/** A keyframe's value as written: `[x, y, z]`, or `{ value, ease }` when it doesn't ease linearly. */
const keyValue = (value: Vec3, ease: Ease): unknown => (ease === "linear" ? [...value] : new Map<string, unknown>([["value", [...value]], ["ease", ease]]));

/**
 * Sets a keyframe at `time` (an existing one there — within a millisecond
 * — changes, keeping its spelling); keys stay in time order.
 */
export function setKey(doc: AnimDoc, clip: string, bone: string, ch: Channel, time: number, value: Vec3, ease: Ease): void {
  const keys = child(tracksOf(doc, clip, bone), ch);
  const at = [...keys.keys()].find((k) => Math.abs(Number(k) - time) < 5e-4) ?? timeText(time);
  keys.set(at, keyValue(value, ease));
  sortKeys(keys);
}

function sortKeys(keys: M): void {
  const sorted = [...keys].sort((a, b) => Number(a[0]) - Number(b[0]));
  keys.clear();
  for (const [k, v] of sorted) keys.set(k, v);
}

export function removeKey(doc: AnimDoc, clip: string, bone: string, ch: Channel, at: string): void {
  const keys = tracksOf(doc, clip, bone).get(ch);
  if (!isMap(keys)) return;
  keys.delete(at);
  if (!keys.size) tracksOf(doc, clip, bone).delete(ch);
}

/** Moves the keyframe at `at` to `time` (replacing one there). */
export function moveKey(doc: AnimDoc, clip: string, bone: string, ch: Channel, at: string, time: number): void {
  const keys = tracksOf(doc, clip, bone).get(ch);
  if (!isMap(keys) || !keys.has(at)) return;
  const v = keys.get(at);
  keys.delete(at);
  for (const k of [...keys.keys()]) if (Math.abs(Number(k) - time) < 5e-4) keys.delete(k);
  keys.set(timeText(time), v);
  sortKeys(keys);
}

// ── Sampling, as yog_body::anim ─────────────────────────────────────────────

const lerp = (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];

function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const t2 = t * t;
  const t3 = t2 * t;
  return [0, 1, 2].map(
    (i) => 0.5 * (2 * p1[i] + (p2[i] - p0[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (3 * p1[i] - p0[i] - 3 * p2[i] + p3[i]) * t3),
  ) as Vec3;
}

/** A track's value at `t` (`null`: no keys). */
export function sampleTrack(k: readonly Key[], t: number): Vec3 | null {
  if (!k.length) return null;
  const first = k[0];
  if (k.length === 1 || t <= first.time) return first.value;
  const last = k[k.length - 1];
  if (t >= last.time) return last.value;
  let i = 0;
  for (let j = 0; j < k.length; j++) if (k[j].time <= t) i = j;
  const a = k[i];
  const b = k[i + 1];
  const s = (t - a.time) / Math.max(b.time - a.time, 1e-6);
  if (a.ease === "step") return a.value;
  if (a.ease === "linear") return lerp(a.value, b.value, s);
  return catmullRom(i > 0 ? k[i - 1].value : a.value, a.value, b.value, k[i + 2]?.value ?? b.value, s);
}

/** The clip's own time `t` seconds after it started, by its loop; `null` once a `once` clip is over. */
export function localTime(c: Clip, t: number): number | null {
  if (c.length <= 0) return 0;
  if (c.loop === "loop") return ((t % c.length) + c.length) % c.length;
  if (c.loop === "hold") return Math.min(Math.max(t, 0), c.length);
  return t <= c.length ? Math.max(t, 0) : null;
}

const DEG = Math.PI / 180;

/** The pose `t` seconds into `clip`: per bone, a turn (radians), a move (pixels), a scale. */
export function samplePose(c: Clip, t: number): PoseOverride {
  const pose: PoseOverride = {};
  const lt = localTime(c, t);
  if (lt === null) return pose;
  for (const b of c.bones) {
    const r = sampleTrack(b.tracks.rotation, lt);
    pose[b.bone] = {
      rotation: r ? [r[0] * DEG, r[1] * DEG, r[2] * DEG] : [0, 0, 0],
      position: sampleTrack(b.tracks.position, lt) ?? [0, 0, 0],
      scale: sampleTrack(b.tracks.scale, lt) ?? [1, 1, 1],
    };
  }
  return pose;
}

/** A new `.yanim`: an idle clip. */
export function newAnimFile(): string {
  return `${formatData({ idle: { length: 2, loop: "loop", bones: {} } }, 0)}\n`;
}
