import { Icon, useT } from "substrate-platform-ui";
import { barBeat, SNAPS, type Snap } from "./grid";

// The transport, along the top as a music program has it: play and stop,
// the position on its display (bar:beat:step and seconds), the tempo and
// beats a bar, what drags snap to, and the zoom.

/** The tempo's range, and the beats a bar's. */
const TEMPO = { min: 20, max: 400 };
const BEATS = { min: 1, max: 16 };
const SNAP_LABEL: Record<Snap, string> = { bar: "Bar", beat: "Beat", half: "½ beat", step: "Step (¼ beat)", none: "No snap" };

interface Props {
  playing: boolean;
  position: number;
  length: number;
  tempo: number;
  beatsPerBar: number;
  snap: Snap;
  readOnly: boolean;
  onPlay: () => void;
  onStop: () => void;
  onTempo: (tempo: number, beatsPerBar: number) => void;
  onSnap: (snap: Snap) => void;
  onZoom: (factor: number) => void;
}

/** How much a zoom button zooms. */
const ZOOM = 1.5;

export function Transport({ playing, position, length, tempo, beatsPerBar, snap, readOnly, onPlay, onStop, onTempo, onSnap, onZoom }: Props) {
  const t = useT();
  return (
    <div className="daw-transport">
      <button className={`daw-btn daw-play${playing ? " on" : ""}`} onClick={playing ? onStop : onPlay} title={t(playing ? "Pause" : "Play")}>
        <Icon name={playing ? "pause" : "play"} />
      </button>
      <button className="daw-btn" onClick={onStop} title={t("Stop")}>
        <Icon name="stop" />
      </button>
      <div className="daw-lcd" title={t("Position")}>
        <span className="daw-lcd-big">{barBeat(position, tempo, beatsPerBar)}</span>
        <span className="daw-lcd-small">
          {position.toFixed(2)} / {length.toFixed(2)} s
        </span>
      </div>
      <label className="daw-field" title={t("Tempo, beats a minute (the grid; the sound doesn't change)")}>
        <span>BPM</span>
        <input type="number" min={TEMPO.min} max={TEMPO.max} value={tempo} disabled={readOnly} onChange={(e) => onTempo(Number(e.target.value), beatsPerBar)} />
      </label>
      <label className="daw-field" title={t("Beats a bar")}>
        <span>{t("Bar")}</span>
        <input type="number" min={BEATS.min} max={BEATS.max} value={beatsPerBar} disabled={readOnly} onChange={(e) => onTempo(tempo, Number(e.target.value))} />
      </label>
      <label className="daw-field" title={t("What dragging snaps to")}>
        <Icon name="grid" />
        <select value={snap} onChange={(e) => onSnap(e.target.value as Snap)}>
          {SNAPS.map((s) => (
            <option key={s} value={s}>
              {t(SNAP_LABEL[s])}
            </option>
          ))}
        </select>
      </label>
      <div className="daw-spacer" />
      <button className="daw-btn" onClick={() => onZoom(1 / ZOOM)} title={t("Zoom out")}>
        −
      </button>
      <button className="daw-btn" onClick={() => onZoom(ZOOM)} title={t("Zoom in")}>
        +
      </button>
    </div>
  );
}
