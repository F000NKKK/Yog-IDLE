import { useT } from "substrate-platform-ui";
import { audioContext } from "../audio";
import { clipBuffer, clipLength, clipSound, type SoundClip } from "../montage";
import { soundLabel } from "../names";
import { Waveform } from "../Waveform";
import { EDGE, LANE } from "./Playlist";

// A clip on its lane, coloured as its track: its sound's name, its
// waveform, its fades drawn over it, the fade handles at its top corners.

interface Props {
  clip: SoundClip;
  buffer: AudioBuffer | null;
  color: string;
  pps: number;
  selected: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}

export function Clip({ clip: c, buffer: b, color, pps, selected, onPointerDown }: Props) {
  const t = useT();
  const w = Math.max(EDGE * 2, (b ? clipLength(b, c) : 0) * pps);
  return (
    <div
      className={`daw-clip${selected ? " selected" : ""}`}
      style={{ left: (c.at ?? 0) * pps, top: (c.track ?? 0) * LANE, width: w, height: LANE, "--clip": color } as React.CSSProperties}
      onPointerDown={onPointerDown}
    >
      <div className="daw-clip-title">{soundLabel(clipSound(c))}</div>
      <Waveform buffer={b ? clipBuffer(audioContext(), b, c) : null} at={null} />
      <svg className="daw-clip-fades" viewBox={`0 0 ${w} ${LANE}`} preserveAspectRatio="none">
        {c.fade_in ? <polygon points={`0,0 ${c.fade_in * pps},0 0,${LANE}`} /> : null}
        {c.fade_out ? <polygon points={`${w},0 ${w - c.fade_out * pps},0 ${w},${LANE}`} /> : null}
      </svg>
      <span className="daw-fade-handle in" title={t("Drag to fade in")} />
      <span className="daw-fade-handle out" title={t("Drag to fade out")} />
    </div>
  );
}
