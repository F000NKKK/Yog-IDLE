import { useState } from "react";
import { Icon, useT } from "substrate-platform-ui";
import { trackColor } from "../sound/daw/grid";
import { soundLabel } from "../sound/names";
import { type Montage, type PictureClip, clipMedia, tidy, withPictureTrack } from "./montage";

// A montage's picture tracks, as a video editor shows them: a lane a
// track, the highest at the top (drawn over the ones below); its clips
// coloured as their track — dragged along or onto another track; the
// mod's videos and pictures dropped in from the media list; the ruler
// clicked to move the playhead.

/** A lane's height, pixels; a clip's least width; lanes shown at least, and spare above the top track. */
const LANE = 40;
const MIN_CLIP = 12;
const MIN_LANES = 3;
const SPARE_LANES = 1;
/** Seconds between the ruler's marks. */
const MARK_SECONDS = 1;
/** Decimals a moved clip's time keeps. */
const TIME_DIGITS = 2;
const ROUND = 10 ** TIME_DIGITS;

/** What a dragged video or picture carries: `video\n@Media.intro`. */
export const MEDIA_DRAG = "application/x-yog-media";
/** The two kinds of media a clip shows. */
export const MEDIA = { video: "video", image: "image" } as const;

interface Props {
  montage: Montage;
  /** How long each clip shows (the render's), seconds. */
  lengths: number[];
  pps: number;
  position: number;
  selected: number | null;
  readOnly: boolean;
  onSelect: (i: number | null) => void;
  onChange: (next: Montage) => void;
  onSeek: (t: number) => void;
}

type Drag = { i: number; x: number; y: number; at: number; track: number };

export function PictureLanes({ montage, lengths, pps, position, selected, readOnly, onSelect, onChange, onSeek }: Props) {
  const t = useT();
  const [drag, setDrag] = useState<Drag | null>(null);
  const [moved, setMoved] = useState<{ at: number; track: number } | null>(null);
  const clips = montage.clips ?? [];
  const lanes = Math.max(MIN_LANES, Math.max(montage.tracks?.length ?? 0, ...clips.map((c) => (c.track ?? 0) + 1)) + SPARE_LANES);
  const end = Math.max(position, ...clips.map((c, i) => (c.at ?? 0) + (lengths[i] ?? 0)), 0);
  const width = (end + MARK_SECONDS * 4) * pps;
  const top = (track: number) => (lanes - 1 - track) * LANE;
  const setClips = (next: PictureClip[]) => onChange({ ...montage, clips: next });

  const down = (e: React.PointerEvent, i: number) => {
    e.stopPropagation();
    onSelect(i);
    if (readOnly) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ i, x: e.clientX, y: e.clientY, at: clips[i].at ?? 0, track: clips[i].track ?? 0 });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const at = Math.round(Math.max(0, drag.at + (e.clientX - drag.x) / pps) * ROUND) / ROUND;
    const track = Math.min(lanes - 1, Math.max(0, drag.track - Math.round((e.clientY - drag.y) / LANE)));
    setMoved({ at, track });
  };
  const up = () => {
    if (drag && moved) setClips(clips.map((c, j) => (j === drag.i ? tidy({ ...c, at: moved.at || undefined, track: moved.track || undefined }) : c)));
    setDrag(null);
    setMoved(null);
  };
  const drop = (e: React.DragEvent) => {
    const [kind, media] = e.dataTransfer.getData(MEDIA_DRAG).split("\n");
    if (!media || readOnly) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const at = Math.round(Math.max(0, (e.clientX - r.left) / pps) * ROUND) / ROUND;
    const track = Math.max(0, lanes - 1 - Math.floor((e.clientY - r.top) / LANE));
    setClips([...clips, tidy({ [kind]: media, at: at || undefined, track: track || undefined })]);
    onSelect(clips.length);
  };
  const key = (e: React.KeyboardEvent) => {
    if ((e.key === "Delete" || e.key === "Backspace") && selected !== null && !readOnly) {
      setClips(clips.filter((_, j) => j !== selected));
      onSelect(null);
    }
  };

  return (
    <div className="video-lanes" tabIndex={0} onKeyDown={key}>
      <div className="video-lane-headers">
        <div className="video-ruler-corner" />
        {Array.from({ length: lanes }, (_, k) => {
          const n = lanes - 1 - k;
          const track = montage.tracks?.[n] ?? {};
          return (
            <div key={n} className="video-lane-header" style={{ "--clip": trackColor(track.color, n) } as React.CSSProperties}>
              <span className="video-lane-name">{track.name || t("Picture {n}", { n: n + 1 })}</span>
              <button
                type="button"
                className="video-lane-eye"
                title={track.hidden ? t("Show") : t("Hide")}
                disabled={readOnly}
                onClick={() => onChange(withPictureTrack(montage, n, { hidden: !track.hidden }))}
              >
                <Icon name={track.hidden ? "eyeOff" : "eye"} size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="video-lanes-body" onPointerMove={move} onPointerUp={up} onPointerDown={() => onSelect(null)}>
        <div className="video-ruler" style={{ width }} onPointerDown={(e) => (e.stopPropagation(), onSeek(Math.max(0, (e.clientX - e.currentTarget.getBoundingClientRect().left) / pps)))}>
          {Array.from({ length: Math.ceil(width / (MARK_SECONDS * pps)) }, (_, k) => (
            <span key={k} style={{ left: k * MARK_SECONDS * pps }}>
              {k * MARK_SECONDS}
            </span>
          ))}
        </div>
        <div className="video-lanes-area" style={{ width, height: lanes * LANE }} onDragOver={(e) => e.preventDefault()} onDrop={drop}>
          {clips.map((c, i) => {
            const shown = drag?.i === i && moved ? { ...c, ...moved } : c;
            const track = shown.track ?? 0;
            const hidden = montage.tracks?.[track]?.hidden;
            return (
              <div
                key={i}
                className={`video-clip${selected === i ? " selected" : ""}${hidden ? " hidden" : ""}`}
                style={{ left: (shown.at ?? 0) * pps, top: top(track), width: Math.max(MIN_CLIP, (lengths[i] ?? 0) * pps), height: LANE, "--clip": trackColor(montage.tracks?.[track]?.color, track) } as React.CSSProperties}
                onPointerDown={(e) => down(e, i)}
              >
                <Icon name={c.video ? "yogVideo" : "yogTexture"} size={12} />
                <span>{soundLabel(clipMedia(c))}</span>
              </div>
            );
          })}
          <div className="video-playhead" style={{ left: position * pps }} />
        </div>
      </div>
    </div>
  );
}
