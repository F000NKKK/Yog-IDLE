import { useT } from "substrate-platform-ui";
import { type Channels, type Mix, UNITY_GAIN } from "../montage";
import { FX_LABEL } from "./montageProperties";
import { trackColor } from "./grid";
import { Meter } from "./Meter";
import { withTrack } from "./TrackHeader";

// The mixer, along the bottom as a music program has it: the master and a
// strip a track — its fader, mute and solo, its effects' slots, its level
// while playing; a strip clicked to edit its effects.

/** The master strip's colour. */
const MASTER_COLOR = "var(--sp-accent)";
/** A fader's range and step. */
const GAIN = { max: 2, step: 0.01 };


/** The strip selected: the master, or track `n`. */
export type Strip = "master" | number;

interface Props {
  mix: Mix;
  shown: Mix;
  tracks: number;
  channels: Channels | null;
  selected: Strip | null;
  readOnly: boolean;
  onSelect: (s: Strip) => void;
  onChange: (next: Mix) => void;
}

export function Mixer({ mix, shown, tracks, channels, selected, readOnly, onSelect, onChange }: Props) {
  const t = useT();
  const strip = (s: Strip) => {
    const master = s === "master";
    const track = master ? null : (shown.tracks?.[s] ?? {});
    const gain = master ? (shown.gain ?? UNITY_GAIN) : (track?.gain ?? UNITY_GAIN);
    const effects = (master ? shown.effects : track?.effects) ?? [];
    const setGain = (v: number) => !readOnly && onChange(master ? { ...mix, gain: v } : withTrack(mix, s, { gain: v }));
    const color = master ? MASTER_COLOR : trackColor(track?.color, s);
    return (
      <div key={String(s)} className={`daw-strip${selected === s ? " selected" : ""}${master ? " master" : ""}`} style={{ "--clip": color } as React.CSSProperties} onClick={() => onSelect(s)}>
        <div className="daw-strip-name">{master ? t("Master") : track?.name || t("Track {n}", { n: s + 1 })}</div>
        <div className="daw-strip-fx">
          {effects.length ? effects.map((e, i) => <div key={i} className="daw-fx-slot on">{t(FX_LABEL[e.fx])}</div>) : <div className="daw-fx-slot">{t("No effects")}</div>}
        </div>
        <div className="daw-strip-body">
          <Meter meter={(master ? channels?.master : channels?.tracks.get(s)) ?? null} />
          <input className="daw-fader" type="range" min={0} max={GAIN.max} step={GAIN.step} value={gain} disabled={readOnly} onChange={(e) => setGain(Number(e.target.value))} />
        </div>
        <div className="daw-strip-gain">{gain.toFixed(2)}</div>
        {!master && (
          <div className="daw-track-controls">
            <button className={`daw-ms${track?.mute ? " on" : ""}`} onClick={(e) => (e.stopPropagation(), !readOnly && onChange(withTrack(mix, s, { mute: !track?.mute })))}>
              M
            </button>
            <button className={`daw-ms solo${track?.solo ? " on" : ""}`} onClick={(e) => (e.stopPropagation(), !readOnly && onChange(withTrack(mix, s, { solo: !track?.solo })))}>
              S
            </button>
          </div>
        )}
      </div>
    );
  };
  return (
    <div className="daw-mixer">
      {strip("master")}
      {Array.from({ length: tracks }, (_, n) => strip(n))}
    </div>
  );
}
