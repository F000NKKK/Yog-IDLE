import { useEffect, useRef } from "react";
import { type Frames, type Render, frameSeconds, playFrom } from "./preview";

// The video designer's screen: the render's frames drawn as the game shows
// them (letterboxed), on its own clock, its sound alongside — from any
// point (unlike the game, the designer can start a sound partway).

/** How often the time shown is told, ms. */
const TELL_EVERY = 100;
const MS = 1000;
/** Around the picture, as the game's cutscenes have it. */
const BACKDROP = "#000";

interface Props {
  render: Render | null;
  frames: Frames | null;
  sound: AudioBuffer | null;
  playing: boolean;
  looping: boolean;
  volume: number;
  /** Where to go, seconds (a new object each time it's asked). */
  seek: { to: number } | null;
  onTime: (seconds: number) => void;
  onEnd: () => void;
}

/** The clock: where it was when it last started, and when that was; the sound playing. */
interface State {
  at: number;
  since: number;
  stop: (() => void) | null;
  /** The seek last gone to (each is gone to once). */
  sought: { to: number } | null;
}

/** What the props say now, read by the loop. */
interface Live {
  playing: boolean;
  looping: boolean;
  volume: number;
  sound: AudioBuffer | null;
  onTime: (seconds: number) => void;
  onEnd: () => void;
}

/** Where the clock is. */
function timeOf(s: State, l: Live): number {
  return l.playing ? s.at + (performance.now() - s.since) / MS : s.at;
}

/** The clock started again at `at`, the sound from there (when it plays). */
function restart(s: State, l: Live, at: number) {
  s.at = at;
  s.since = performance.now();
  s.stop?.();
  s.stop = l.sound && l.playing ? playFrom(l.sound, at, l.volume) : null;
}

/** The part of `w`×`h` a picture of `iw`×`ih` fills, kept in proportion. */
function letterbox(w: number, h: number, iw: number, ih: number): [number, number, number, number] {
  const scale = Math.min(w / iw, h / ih);
  const [dw, dh] = [iw * scale, ih * scale];
  return [(w - dw) / 2, (h - dh) / 2, dw, dh];
}

export function VideoPlayer({ render, frames, sound, playing, looping, volume, seek, onTime, onEnd }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef<State>({ at: 0, since: 0, stop: null, sought: null });
  const live = useRef<Live>({ playing, looping, volume, sound, onTime, onEnd });
  live.current = { playing, looping, volume, sound, onTime, onEnd };

  // Play, pause, seek, a new render: the clock restarts from where it is (or
  // was sent), the sound with it.
  useEffect(() => {
    const s = state.current;
    const sent = seek && seek !== s.sought ? seek.to : s.at;
    s.sought = seek;
    restart(s, live.current, sent);
    return () => {
      s.at = timeOf(s, live.current);
      s.stop?.();
      s.stop = null;
    };
  }, [playing, seek, sound, render]);

  useEffect(() => {
    if (!render || !frames) return;
    const s = state.current;
    const length = render.frames * frameSeconds(render);
    let told = 0;
    let raf = 0;
    const draw = () => {
      const l = live.current;
      let at = timeOf(s, l);
      if (at >= length) {
        if (l.looping) {
          at %= length;
          restart(s, l, at);
        } else {
          at = length;
          l.onEnd();
        }
      }
      const frame = Math.min(Math.floor(at / frameSeconds(render)), render.frames - 1);
      const img = frames.get(frame, () => undefined) ?? frames.before(frame);
      const c = canvas.current;
      const g = c?.getContext("2d");
      if (c && g) {
        const [w, h] = [c.clientWidth * devicePixelRatio, c.clientHeight * devicePixelRatio];
        if (c.width !== w || c.height !== h) [c.width, c.height] = [w, h];
        g.fillStyle = BACKDROP;
        g.fillRect(0, 0, w, h);
        if (img) g.drawImage(img, ...letterbox(w, h, render.width, render.height));
      }
      const t = performance.now();
      if (t - told > TELL_EVERY) {
        told = t;
        l.onTime(at);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [render, frames]);

  return <canvas ref={canvas} className="video-player" />;
}
