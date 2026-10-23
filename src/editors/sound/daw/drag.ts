import { clipLength, type SoundClip } from "../montage";

// A clip dragged in the playlist: moved (onto another track too), its
// start or end cut, its fades drawn — snapped, times kept to milliseconds.

export type Mode = "move" | "start" | "end" | "fade_in" | "fade_out";

/** The shortest a clip is cut to, seconds; times kept to milliseconds. */
const MIN_CLIP = 0.01;
const MS = 1000;

export const round = (v: number) => Math.round(v * MS) / MS;

/** A drag: the clip as written, as shown, its sound; how far, seconds and lanes. */
export interface Dragged {
  clip: SoundClip;
  shown: SoundClip;
  buffer: AudioBuffer;
  mode: Mode;
  dx: number;
  lanes: number;
}

/** The clip after the drag `d`, times snapped by `snap`. */
export function moved({ clip: c, shown: s, buffer: b, mode, dx, lanes }: Dragged, snap: (t: number) => number): SoundClip {
  const speed = s.speed ?? 1, from = s.from ?? 0, to = Math.min(s.to ?? b.duration, b.duration), len = clipLength(b, s);
  switch (mode) {
    case "move":
      return { ...c, at: round(Math.max(0, snap((s.at ?? 0) + dx))), track: Math.max(0, (s.track ?? 0) + lanes) };
    case "start": {
      const at = Math.max(0, snap((s.at ?? 0) + dx));
      const next = Math.min(Math.max(0, from + (at - (s.at ?? 0)) * speed), to - MIN_CLIP);
      return { ...c, from: round(next), at: round((s.at ?? 0) + (next - from) / speed) };
    }
    case "end": {
      const stop = snap((s.at ?? 0) + len + dx);
      return { ...c, to: round(Math.max(from + MIN_CLIP, Math.min(b.duration, from + (stop - (s.at ?? 0)) * speed))) };
    }
    case "fade_in":
      return { ...c, fade_in: round(Math.min(len, Math.max(0, (s.fade_in ?? 0) + dx))) };
    case "fade_out":
      return { ...c, fade_out: round(Math.min(len, Math.max(0, (s.fade_out ?? 0) - dx))) };
  }
}
