import { useRef, useState } from "react";
import { useT } from "substrate-platform-ui";
import { audioContext } from "../audio";
import { clipBuffer, clipLength, clipSound, type Mix, type SoundClip } from "../montage";
import { Waveform } from "../Waveform";
import { soundLabel } from "../names";
import { SOUND_DRAG } from "./Browser";
import { beatSeconds, css, type Snap, snapped, trackColor } from "./grid";
import { TrackHeader } from "./TrackHeader";

// The playlist, as a music program has it: a lane a track, its header on
// the left, the bars and beats behind; clips coloured as their track,
// their waveform in them — dragged to move (onto another track too),
// their edges dragged to cut, their top corners to fade; sounds dropped
// from the browser; the ruler clicked to move the playhead.

/** A lane's height, pixels; a clip's edge and fade handles'. */
export const LANE = 56;
const EDGE = 6;
const FADE = 10;
/** The shortest a clip is cut to, seconds; times kept to milliseconds. */
const MIN_CLIP = 0.01;
const MS = 1000;
/** Empty lanes below the last track, to drop onto; the fewest lanes shown. */
const SPARE_LANES = 1;
const MIN_LANES = 8;

type Mode = "move" | "start" | "end" | "fade_in" | "fade_out";
type Drag = { i: number; mode: Mode; x: number; y: number; clip: SoundClip };

interface Props {
  mix: Mix;
  shown: Mix;
  buffers: (AudioBuffer | null)[];
  pps: number;
  snap: Snap;
  position: number;
  selected: number | null;
  readOnly: boolean;
  onSelect: (i: number | null) => void;
  onChange: (next: Mix) => void;
  onSeek: (t: number) => void;
}

const round = (v: number) => Math.round(v * MS) / MS;

/** A clip without what's left unset. */
const tidy = (c: SoundClip): SoundClip => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined && v !== null && v !== false)) as SoundClip;

export function Playlist({ mix, shown, buffers, pps, snap, position, selected, readOnly, onSelect, onChange, onSeek }: Props) {
  const t = useT();
  const [drag, setDrag] = useState<Drag | null>(null);
  const [draft, setDraft] = useState<SoundClip | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const tempo = shown.tempo ?? 0, bpb = shown.beats_per_bar ?? 0;
  const snap1 = (v: number) => snapped(v, snap, tempo, bpb);
  const lanes = Math.max(MIN_LANES, Math.max(shown.tracks?.length ?? 0, ...shown.clips.map((c) => (c.track ?? 0) + 1)) + SPARE_LANES);
  const end = Math.max(...shown.clips.map((c, i) => (buffers[i] ? (c.at ?? 0) + clipLength(buffers[i]!, c) : 0)), position, 0);
  const beat = beatSeconds(tempo) * pps, bar = beat * bpb;
  const width = Math.max((end + beatSeconds(tempo) * bpb * 2) * pps, area.current?.clientWidth ?? 0);

  const setClips = (clips: SoundClip[]) => onChange({ ...mix, clips });
  const clipAt = (i: number) => (drag?.i === i && draft ? { ...shown.clips[i], ...draft } : shown.clips[i]);

  /** `s` (shown), `b` its sound, dragged `dx` seconds and `dl` lanes as `mode` says. */
  const moved = (c: SoundClip, s: SoundClip, b: AudioBuffer, mode: Mode, dx: number, dl: number): SoundClip => {
    const speed = s.speed ?? 1, from = s.from ?? 0, to = Math.min(s.to ?? b.duration, b.duration), len = clipLength(b, s);
    switch (mode) {
      case "move":
        return { ...c, at: round(Math.max(0, snap1((s.at ?? 0) + dx))), track: Math.max(0, (s.track ?? 0) + dl) };
      case "start": {
        const at = Math.max(0, snap1((s.at ?? 0) + dx));
        const next = Math.min(Math.max(0, from + (at - (s.at ?? 0)) * speed), to - MIN_CLIP);
        return { ...c, from: round(next), at: round((s.at ?? 0) + (next - from) / speed) };
      }
      case "end": {
        const stop = snap1((s.at ?? 0) + len + dx);
        return { ...c, to: round(Math.max(from + MIN_CLIP, Math.min(b.duration, from + (stop - (s.at ?? 0)) * speed))) };
      }
      case "fade_in":
        return { ...c, fade_in: round(Math.min(len, Math.max(0, (s.fade_in ?? 0) + dx))) };
      case "fade_out":
        return { ...c, fade_out: round(Math.min(len, Math.max(0, (s.fade_out ?? 0) - dx))) };
    }
  };

  const down = (e: React.PointerEvent, i: number) => {
    e.stopPropagation();
    onSelect(i);
    if (readOnly || !buffers[i]) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const mode: Mode = y < FADE && x < FADE * 2 ? "fade_in" : y < FADE && r.width - x < FADE * 2 ? "fade_out" : x < EDGE ? "start" : r.width - x < EDGE ? "end" : "move";
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ i, mode, x: e.clientX, y: e.clientY, clip: mix.clips[i] });
  };
  const move = (e: React.PointerEvent) => {
    const b = drag && buffers[drag.i];
    if (!drag || !b) return;
    setDraft(moved(drag.clip, shown.clips[drag.i], b, drag.mode, (e.clientX - drag.x) / pps, Math.round((e.clientY - drag.y) / LANE)));
  };
  const up = () => {
    if (drag && draft) setClips(mix.clips.map((c, j) => (j === drag.i ? tidy(draft) : c)));
    setDrag(null);
    setDraft(null);
  };

  /** A sound dropped from the browser: a clip where it fell. */
  const drop = (e: React.DragEvent) => {
    const sound = e.dataTransfer.getData(SOUND_DRAG);
    const r = e.currentTarget.getBoundingClientRect();
    if (!sound || readOnly) return;
    e.preventDefault();
    const at = round(Math.max(0, snap1((e.clientX - r.left) / pps)));
    const track = Math.max(0, Math.floor((e.clientY - r.top) / LANE));
    const clip: SoundClip = tidy({ ...(sound.startsWith("@") ? { sound } : { file: sound }), at, track });
    setClips([...mix.clips, clip]);
    onSelect(mix.clips.length);
  };
  const key = (e: React.KeyboardEvent) => {
    if ((e.key === "Delete" || e.key === "Backspace") && selected !== null && !readOnly) {
      setClips(mix.clips.filter((_, j) => j !== selected));
      onSelect(null);
    }
  };

  const grid = { backgroundImage: `repeating-linear-gradient(90deg, var(--daw-bar) 0 1px, transparent 1px ${bar}px), repeating-linear-gradient(90deg, var(--daw-beat) 0 1px, transparent 1px ${beat}px)` };
  return (
    <div className="daw-playlist" tabIndex={0} onKeyDown={key}>
      <div className="daw-headers">
        <div className="daw-ruler-corner" />
        {Array.from({ length: lanes }, (_, n) => (
          <TrackHeader key={n} n={n} mix={mix} shown={shown} readOnly={readOnly} onChange={onChange} />
        ))}
      </div>
      <div className="daw-lanes" ref={area} onPointerMove={move} onPointerUp={up} onPointerDown={() => onSelect(null)}>
        <div className="daw-ruler" style={{ width }} onPointerDown={(e) => (e.stopPropagation(), onSeek(Math.max(0, (e.clientX - e.currentTarget.getBoundingClientRect().left) / pps)))}>
          {Array.from({ length: Math.ceil(width / bar) }, (_, k) => (
            <span key={k} style={{ left: k * bar }}>
              {k + 1}
            </span>
          ))}
        </div>
        <div className="daw-tracks" style={{ width, height: lanes * LANE, ...grid }} onDragOver={(e) => e.preventDefault()} onDrop={drop}>
          {shown.clips.map((_, i) => {
            const c = clipAt(i), b = buffers[i];
            const color = css(trackColor(shown.tracks?.[c.track ?? 0]?.color, c.track ?? 0));
            const len = b ? clipLength(b, c) : 0;
            const w = Math.max(EDGE * 2, len * pps);
            return (
              <div
                key={i}
                className={`daw-clip${selected === i ? " selected" : ""}`}
                style={{ left: (c.at ?? 0) * pps, top: (c.track ?? 0) * LANE, width: w, height: LANE, "--clip": color } as React.CSSProperties}
                onPointerDown={(e) => down(e, i)}
              >
                <div className="daw-clip-title">{soundLabel(clipSound(c))}</div>
                <Waveform buffer={b ? clipBuffer(audioContext(), b, c) : null} at={null} />
                <svg className="daw-clip-fades" viewBox={`0 0 ${w} ${LANE}`} preserveAspectRatio="none">
                  {c.fade_in ? <polygon points={`0,0 ${(c.fade_in ?? 0) * pps},0 0,${LANE}`} /> : null}
                  {c.fade_out ? <polygon points={`${w},0 ${w - (c.fade_out ?? 0) * pps},0 ${w},${LANE}`} /> : null}
                </svg>
                <span className="daw-fade-handle in" title={t("Drag to fade in")} />
                <span className="daw-fade-handle out" title={t("Drag to fade out")} />
              </div>
            );
          })}
          <div className="daw-playhead" style={{ left: position * pps }} />
        </div>
      </div>
    </div>
  );
}
