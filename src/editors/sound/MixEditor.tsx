import { useEffect, useRef, useState } from "react";
import { Icon, useT } from "substrate-platform-ui";
import { audioContext, loadSound } from "./audio";
import { ClipInspector } from "./ClipInspector";
import { EffectsEditor } from "./EffectsEditor";
import { clipBuffer, clipLength, clipSound, type Mix, mixLength, playMix, type SoundClip } from "./montage";
import { Waveform } from "./Waveform";

// A montage on a timeline: a lane a clip, each where it starts and as long
// as it plays — dragged to move it, its edges dragged to cut it; the
// selected one's settings on the right (the mix's effects with none
// selected); played as the build renders it, the playhead moving.

/** Pixels a second at first, and how much a zoom step changes it. */
const START_PPS = 200;
const ZOOM = 1.5;
const MIN_PPS = 20;
const MAX_PPS = 2000;
/** The shortest a clip is cut to, seconds. */
const MIN_CLIP = 0.01;
/** A clip's edge handles, pixels; where the ruler ticks, seconds. */
const HANDLE = 6;
const TICK = 0.5;
/** Times are kept to this many decimals. */
const PRECISION = 1000;

type Drag = { i: number; mode: "move" | "start" | "end"; x: number; clip: SoundClip };

interface Props {
  path: string;
  /** The mix as written, and with its defaults. */
  mix: Mix;
  shown: Mix;
  readOnly: boolean;
  onChange: (next: Mix) => void;
}

const round = (v: number) => Math.round(v * PRECISION) / PRECISION;
/** A clip without what it leaves at its default. */
const tidy = (c: SoundClip): SoundClip => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined && v !== null)) as SoundClip;

/** `c` (shown as `s`, its sound `b`) dragged `dx` seconds as `mode` says. */
function dragged(c: SoundClip, s: SoundClip, b: AudioBuffer, mode: Drag["mode"], dx: number): SoundClip {
  const speed = s.speed ?? 1, from = s.from ?? 0, to = Math.min(s.to ?? b.duration, b.duration);
  if (mode === "move") return { ...c, at: round(Math.max(0, (s.at ?? 0) + dx)) };
  if (mode === "start") {
    const next = Math.min(Math.max(0, from + dx * speed), to - MIN_CLIP);
    return { ...c, from: round(next), at: round(Math.max(0, (s.at ?? 0) + (next - from) / speed)) };
  }
  return { ...c, to: round(Math.max(from + MIN_CLIP, Math.min(b.duration, to + dx * speed))) };
}

export function MixEditor({ path, mix, shown, readOnly, onChange }: Props) {
  const t = useT();
  const [buffers, setBuffers] = useState<(AudioBuffer | null)[]>([]);
  const [pps, setPps] = useState(START_PPS);
  const [selected, setSelected] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [draft, setDraft] = useState<SoundClip | null>(null);
  const [head, setHead] = useState<number | null>(null);
  const [adding, setAdding] = useState("");
  const playing = useRef<{ stop: () => void } | null>(null);
  const key = shown.clips.map(clipSound).join("\n");

  // The clips' sounds, loaded again only when their sources change.
  useEffect(() => {
    let live = true;
    const sounds = key ? key.split("\n") : [];
    void Promise.all(sounds.map((s) => loadSound(path, s).catch(() => null))).then((b) => live && setBuffers(b));
    return () => {
      live = false;
    };
  }, [path, key]);
  useEffect(() => () => playing.current?.stop(), []);

  const clipAt = (i: number) => (drag?.i === i && draft ? { ...shown.clips[i], ...draft } : shown.clips[i]);
  const setClip = (i: number, next: SoundClip | null) =>
    onChange({ ...mix, clips: next ? mix.clips.map((c, j) => (j === i ? tidy(next) : c)) : mix.clips.filter((_, j) => j !== i) });

  const play = () => {
    if (playing.current) return playing.current.stop();
    const ctx = audioContext();
    void ctx.resume();
    const start = ctx.currentTime;
    const sources = playMix(ctx, shown, buffers, ctx.destination, start);
    const length = mixLength(shown, buffers);
    let frame = 0;
    const stop = () => {
      sources.forEach((s) => s.stop());
      cancelAnimationFrame(frame);
      setHead(null);
      playing.current = null;
    };
    const tick = () => {
      const now = ctx.currentTime - start;
      if (now >= length) return stop();
      setHead(now);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    playing.current = { stop };
  };

  const down = (e: React.PointerEvent, i: number) => {
    setSelected(i);
    if (readOnly || !buffers[i]) return;
    const r = e.currentTarget.getBoundingClientRect();
    const mode = e.clientX - r.left < HANDLE ? "start" : r.right - e.clientX < HANDLE ? "end" : "move";
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ i, mode, x: e.clientX, clip: mix.clips[i] });
  };
  const move = (e: React.PointerEvent) => {
    const b = drag && buffers[drag.i];
    if (!drag || !b) return;
    setDraft(dragged(drag.clip, shown.clips[drag.i], b, drag.mode, (e.clientX - drag.x) / pps));
  };
  const up = () => {
    if (drag && draft) setClip(drag.i, draft);
    setDrag(null);
    setDraft(null);
  };

  const add = () => {
    const s = adding.trim();
    if (!s) return;
    const at = round(mixLength(shown, buffers));
    onChange({ ...mix, clips: [...mix.clips, s.startsWith("@") ? { sound: s, at } : { file: s, at }] });
    setAdding("");
  };

  const length = Math.max(mixLength(shown, buffers), 1);
  const ticks = Array.from({ length: Math.ceil(length / TICK) + 1 }, (_, k) => k * TICK);
  const sel = selected !== null && selected < shown.clips.length ? selected : null;
  return (
    <div className="mix-editor">
      <div className="mix-toolbar">
        <button onClick={play} title={t(head === null ? "Play" : "Stop")}>
          <Icon name={head === null ? "play" : "stop"} />
        </button>
        <button onClick={() => setPps(Math.max(MIN_PPS, pps / ZOOM))} title={t("Zoom out")}>−</button>
        <button onClick={() => setPps(Math.min(MAX_PPS, pps * ZOOM))} title={t("Zoom in")}>+</button>
        <span className="mix-length">{t("{s} s", { s: mixLength(shown, buffers).toFixed(2) })}</span>
        {!readOnly && (
          <>
            <input value={adding} placeholder={t("@Sounds.name, or the game's minecraft:dig/sand1")} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
            <button onClick={add}>{t("Add a clip")}</button>
          </>
        )}
      </div>
      <div className="mix-body">
        <div className="mix-timeline" onPointerMove={move} onPointerUp={up}>
          <div className="mix-ruler" style={{ width: length * pps }}>
            {ticks.map((s) => (
              <span key={s} style={{ left: s * pps }}>
                {s.toFixed(1)}
              </span>
            ))}
          </div>
          {shown.clips.map((_, i) => {
            const c = clipAt(i), b = buffers[i];
            const width = b ? clipLength(b, c) * pps : HANDLE * 4;
            return (
              <div className="mix-lane" key={i} style={{ width: length * pps }}>
                <div className={`mix-clip${sel === i ? " selected" : ""}`} style={{ left: (c.at ?? 0) * pps, width }} onPointerDown={(e) => down(e, i)}>
                  <Waveform buffer={b ? clipBuffer(audioContext(), b, c) : null} at={null} />
                  <span className="mix-clip-name">{clipSound(c)}</span>
                </div>
              </div>
            );
          })}
          {head !== null && <div className="mix-head" style={{ left: head * pps }} />}
        </div>
        <div className="mix-inspector">
          {sel !== null ? (
            <>
              <ClipInspector clip={mix.clips[sel]} shown={shown.clips[sel]} readOnly={readOnly} onChange={(next) => setClip(sel, next)} />
              {!readOnly && <button onClick={() => (setClip(sel, null), setSelected(null))}>{t("Remove the clip")}</button>}
            </>
          ) : (
            <>
              <div className="sound-clip-subtitle">{t("The mix's effects")}</div>
              <EffectsEditor effects={mix.effects ?? []} readOnly={readOnly} onChange={(effects) => onChange({ ...mix, effects: effects.length ? effects : undefined })} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
