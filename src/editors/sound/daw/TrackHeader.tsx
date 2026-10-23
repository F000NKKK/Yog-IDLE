import { useState } from "react";
import { useT } from "substrate-platform-ui";
import { type Mix, type Track, UNITY_GAIN } from "../montage";
import { hexOf, trackColor } from "./grid";

// A track's header, left of its lane: its colour (clicked to change), its
// name (double-clicked to rename), mute and solo, and its volume.

/** The volume slider's range and step. */
const GAIN = { max: 2, step: 0.01 };

interface Props {
  n: number;
  mix: Mix;
  shown: Mix;
  readOnly: boolean;
  onChange: (next: Mix) => void;
}

/** `mix` with track `n` changed by `patch` (the tracks before it made, empty). */
export function withTrack(mix: Mix, n: number, patch: Partial<Track>): Mix {
  const tracks = [...(mix.tracks ?? [])];
  while (tracks.length <= n) tracks.push({});
  const next: Track = { ...tracks[n], ...patch };
  tracks[n] = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== false && v !== "")) as Track;
  return { ...mix, tracks };
}

export function TrackHeader({ n, mix, shown, readOnly, onChange }: Props) {
  const t = useT();
  const [renaming, setRenaming] = useState(false);
  const track = shown.tracks?.[n] ?? {};
  const color = trackColor(track.color, n);
  const set = (patch: Partial<Track>) => !readOnly && onChange(withTrack(mix, n, patch));
  const name = track.name || t("Track {n}", { n: n + 1 });
  return (
    <div className="daw-track-header" style={{ "--clip": color } as React.CSSProperties}>
      <label className="daw-track-color" title={t("Colour")}>
        <input type="color" value={hexOf(color)} disabled={readOnly} onChange={(e) => set({ color: parseInt(e.target.value.slice(1), 16) })} />
      </label>
      <div className="daw-track-main">
        {renaming ? (
          <input
            className="daw-track-rename"
            autoFocus
            defaultValue={track.name ?? ""}
            onBlur={(e) => (set({ name: e.target.value || undefined }), setRenaming(false))}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <div className="daw-track-name" onDoubleClick={() => !readOnly && setRenaming(true)} title={t("Double-click to rename")}>
            {name}
          </div>
        )}
        <div className="daw-track-controls">
          <button className={`daw-ms${track.mute ? " on" : ""}`} onClick={() => set({ mute: !track.mute })} title={t("Mute")}>
            M
          </button>
          <button className={`daw-ms solo${track.solo ? " on" : ""}`} onClick={() => set({ solo: !track.solo })} title={t("Solo")}>
            S
          </button>
          <input
            type="range"
            min={0}
            max={GAIN.max}
            step={GAIN.step}
            value={track.gain ?? UNITY_GAIN}
            disabled={readOnly}
            onChange={(e) => set({ gain: Number(e.target.value) })}
            title={t("Volume {v}", { v: (track.gain ?? UNITY_GAIN).toFixed(2) })}
          />
        </div>
      </div>
    </div>
  );
}
