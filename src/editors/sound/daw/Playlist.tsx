import { useRef, useState } from "react";
import { clipLength, type Mix, type SoundClip } from "../montage";
import { SOUND_DRAG } from "./Browser";
import { Clip } from "./Clip";
import { type Mode, moved, round } from "./drag";
import { beatSeconds, type Snap, snapped, trackColor } from "./grid";
import { TrackHeader } from "./TrackHeader";

// The playlist, as a music program has it: a lane a track, its header on
// the left, the bars and beats behind; clips coloured as their track,
// their waveform in them — dragged to move (onto another track too),
// their edges dragged to cut, their top corners to fade; sounds dropped
// from the browser; the ruler clicked to move the playhead.

/** A lane's height, pixels; a clip's edge and fade handles'. */
export const LANE = 56;
export const EDGE = 6;
const FADE = 10;
/** Empty lanes below the last track, to drop onto; the fewest lanes shown. */
const SPARE_LANES = 1;
const MIN_LANES = 8;

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

/** A clip without what's left unset. */
const tidy = (c: SoundClip): SoundClip => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined && v !== null && v !== false)) as SoundClip;

/** The bars' numbers along the top; clicked, the playhead moves there. */
function Ruler({ width, bar, pps, onSeek }: { width: number; bar: number; pps: number; onSeek: (t: number) => void }) {
  return (
    <div className="daw-ruler" style={{ width }} onPointerDown={(e) => (e.stopPropagation(), onSeek(Math.max(0, (e.clientX - e.currentTarget.getBoundingClientRect().left) / pps)))}>
      {Array.from({ length: Math.ceil(width / bar) }, (_, k) => (
        <span key={k} style={{ left: k * bar }}>
          {k + 1}
        </span>
      ))}
    </div>
  );
}

export function Playlist({ mix, shown, buffers, pps, snap, position, selected, readOnly, onSelect, onChange, onSeek }: Props) {
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
    setDraft(moved({ clip: drag.clip, shown: shown.clips[drag.i], buffer: b, mode: drag.mode, dx: (e.clientX - drag.x) / pps, lanes: Math.round((e.clientY - drag.y) / LANE) }, snap1));
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
        <Ruler width={width} bar={bar} pps={pps} onSeek={onSeek} />
        <div className="daw-tracks" style={{ width, height: lanes * LANE, ...grid }} onDragOver={(e) => e.preventDefault()} onDrop={drop}>
          {shown.clips.map((_, i) => {
            const c = clipAt(i);
            return <Clip key={i} clip={c} buffer={buffers[i]} color={trackColor(shown.tracks?.[c.track ?? 0]?.color, c.track ?? 0)} pps={pps} selected={selected === i} onPointerDown={(e) => down(e, i)} />;
          })}
          <div className="daw-playhead" style={{ left: position * pps }} />
        </div>
      </div>
    </div>
  );
}
