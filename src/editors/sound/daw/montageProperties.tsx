import type { PropertyDescriptor, PropertyValue } from "substrate-platform-ui";
import { type Mix, type SoundClip, type SoundEffect, type Track, UNITY_GAIN } from "../montage";
import { soundLabel } from "../names";
import { hexOf, trackColor } from "./grid";
import { withTrack } from "./TrackHeader";
import type { Strip } from "./Mixer";

// A montage's settings in the IDE's Properties: the mix's (tempo, beats a
// bar, the master's volume) always; the selected clip's, or the selected
// mixer channel's — each effect's settings among them, and a row to add
// or remove effects.

type T = (s: string, p?: Record<string, string | number>) => string;

/** A new effect of each kind: an echo a fifth of a second later, a muffle, a thin phone. */
const NEW: Record<SoundEffect["fx"], SoundEffect> = {
  echo: { fx: "echo", delay: 0.2, decay: 0.4 },
  low_pass: { fx: "low_pass", hz: 800 },
  high_pass: { fx: "high_pass", hz: 2000 },
};
export const FX_LABEL: Record<SoundEffect["fx"], string> = { echo: "Echo", low_pass: "Low pass", high_pass: "High pass" };
/** Steps a drag on a row's name moves a value by. */
const STEP = { time: 0.01, gain: 0.05, tempo: 1, hz: 50 } as const;
const HEX = 16;

interface Args {
  mix: Mix;
  shown: Mix;
  clip: number | null;
  strip: Strip | null;
  sounds: readonly string[];
  readOnly: boolean;
  t: T;
  onChange: (next: Mix) => void;
}

/** Where a row is: its id, name and category. */
type Row = Pick<PropertyDescriptor, "id" | "name" | "category">;

/** A number row; empty commits `undefined` (the default). */
function num(row: Row, value: number | null | undefined, step: number, commit: (v: number | undefined) => void): PropertyDescriptor {
  return {
    ...row,
    value: value ?? null,
    kind: "number",
    step,
    onCommit: (v: PropertyValue) => commit(String(v).trim() === "" ? undefined : Number(v)),
  };
}

/** The rows of `effects` (category `category`), changed by `set`. */
function effectRows(prefix: string, category: string, effects: SoundEffect[], set: (next: SoundEffect[]) => void, a: Args): PropertyDescriptor[] {
  const { t, readOnly } = a;
  const put = (i: number, e: SoundEffect) => set(effects.map((x, j) => (j === i ? e : x)));
  const rows = effects.flatMap((e, i): PropertyDescriptor[] => {
    const label = `${t(FX_LABEL[e.fx])} ${i + 1}`;
    if (e.fx === "echo") {
      return [
        num({ id: `${prefix}.fx${i}.delay`, name: `${label}: ${t("Delay, s")}`, category }, e.delay, STEP.time, (v) => put(i, { ...e, delay: v ?? 0 })),
        num({ id: `${prefix}.fx${i}.decay`, name: `${label}: ${t("Decay")}`, category }, e.decay, STEP.gain, (v) => put(i, { ...e, decay: v ?? 0 })),
      ];
    }
    return [num({ id: `${prefix}.fx${i}.hz`, name: `${label}: ${t("Hz")}`, category }, e.hz, STEP.hz, (v) => put(i, { ...e, hz: v ?? 0 }))];
  });
  rows.push({
    id: `${prefix}.fx.edit`,
    name: t("Effects"),
    category,
    value: null,
    kind: "custom",
    render: () => (
      <div className="daw-fx-edit">
        {effects.map((e, i) => (
          <button key={i} disabled={readOnly} onClick={() => set(effects.filter((_, j) => j !== i))} title={t("Remove")}>
            × {t(FX_LABEL[e.fx])} {i + 1}
          </button>
        ))}
        {(Object.keys(NEW) as SoundEffect["fx"][]).map((fx) => (
          <button key={fx} disabled={readOnly} onClick={() => set([...effects, NEW[fx]])}>
            + {t(FX_LABEL[fx])}
          </button>
        ))}
      </div>
    ),
  });
  return rows;
}

/** The selected clip's rows. */
function clipRows(i: number, a: Args): PropertyDescriptor[] {
  const { mix, shown, t, onChange } = a;
  const raw = mix.clips[i], s = shown.clips[i] ?? raw;
  const cat = t("Fragment");
  const put = (patch: Partial<SoundClip>) => onChange({ ...mix, clips: mix.clips.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const sound = raw.sound ?? raw.file ?? "";
  const time = (key: "at" | "from" | "to" | "fade_in" | "fade_out", name: string) => num({ id: `clip.${key}`, name: t(name), category: cat }, s[key], STEP.time, (v) => put({ [key]: v }));
  return [
    {
      id: "clip.sound",
      name: t("Sound"),
      category: cat,
      value: sound,
      displayValue: soundLabel(sound),
      description: t("The mod's sound (@Set.name) or a sound file the game has (minecraft:dig/sand1)."),
      suggestions: a.sounds,
      onCommit: (v) => {
        const next = String(v).trim();
        put(next.startsWith("@") ? { sound: next, file: undefined } : { file: next, sound: undefined });
      },
    },
    num({ id: "clip.track", name: t("Track number"), category: cat }, (s.track ?? 0) + 1, 1, (v) => put({ track: Math.max(0, (v ?? 1) - 1) })),
    time("at", "Starts at, s"),
    time("from", "From, s"),
    time("to", "To, s"),
    num({ id: "clip.gain", name: t("Gain"), category: cat }, s.gain, STEP.gain, (v) => put({ gain: v })),
    time("fade_in", "Fade in, s"),
    time("fade_out", "Fade out, s"),
    num({ id: "clip.speed", name: t("Speed (pitch)"), category: cat }, s.speed, STEP.gain, (v) => put({ speed: v })),
    { id: "clip.reverse", name: t("Backwards"), category: cat, value: !!s.reverse, kind: "bool", onCommit: (v) => put({ reverse: v ? true : undefined }) },
    ...effectRows("clip", t("Fragment's effects"), raw.effects ?? [], (fx) => put({ effects: fx.length ? fx : undefined }), a),
  ];
}

/** The selected track's rows. */
function trackRows(n: number, a: Args): PropertyDescriptor[] {
  const { mix, shown, t, onChange } = a;
  const tr: Track = shown.tracks?.[n] ?? {};
  const cat = t("Track {n}", { n: n + 1 });
  const put = (patch: Partial<Track>) => onChange(withTrack(mix, n, patch));
  const color = hexOf(trackColor(tr.color, n));
  return [
    { id: "track.name", name: t("Name"), category: cat, value: tr.name ?? "", onCommit: (v) => put({ name: String(v) || undefined }) },
    { id: "track.color", name: t("Colour"), category: cat, value: color, swatch: color, onCommit: (v) => put({ color: parseInt(String(v).replace("#", ""), HEX) }) },
    num({ id: "track.gain", name: t("Volume"), category: cat }, tr.gain ?? UNITY_GAIN, STEP.gain, (v) => put({ gain: v })),
    { id: "track.mute", name: t("Mute"), category: cat, value: !!tr.mute, kind: "bool", onCommit: (v) => put({ mute: !!v }) },
    { id: "track.solo", name: t("Solo"), category: cat, value: !!tr.solo, kind: "bool", onCommit: (v) => put({ solo: !!v }) },
    ...effectRows("track", t("Track {n}'s effects", { n: n + 1 }), mix.tracks?.[n]?.effects ?? [], (fx) => put({ effects: fx.length ? fx : undefined }), a),
  ];
}

/** Every row the montage shows in Properties. */
export function montageProperties(a: Args): PropertyDescriptor[] {
  const { mix, shown, t, readOnly, onChange, clip, strip } = a;
  const cat = t("Montage");
  const rows: PropertyDescriptor[] = [
    num({ id: "mix.tempo", name: t("Tempo, BPM"), category: cat }, shown.tempo, STEP.tempo, (v) => onChange({ ...mix, tempo: v })),
    num({ id: "mix.beats", name: t("Beats a bar"), category: cat }, shown.beats_per_bar, 1, (v) => onChange({ ...mix, beats_per_bar: v })),
    num({ id: "mix.gain", name: t("Master volume"), category: cat }, shown.gain, STEP.gain, (v) => onChange({ ...mix, gain: v })),
  ];
  const selected =
    clip !== null && mix.clips[clip]
      ? clipRows(clip, a)
      : typeof strip === "number"
        ? trackRows(strip, a)
        : strip === "master"
          ? effectRows("master", t("Master's effects"), mix.effects ?? [], (fx) => onChange({ ...mix, effects: fx.length ? fx : undefined }), a)
          : [];
  return [...rows, ...selected].map((r) => (readOnly ? { ...r, readOnly: true } : r));
}
