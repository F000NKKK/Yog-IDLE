// A `.yvideo` as the game will show it, through the CLI: rendered as the
// build renders it (`video_preview`), its frames decoded as the game
// decodes them (`video_frame`, PNG) and kept, its sound decoded for
// WebAudio.

import { serveMethod } from "../../data/yogIds.generated";
import { cli } from "../../cli";
import { audioContext, bytesOf, decodeSound } from "../sound/audio";

/** What `video_preview` answers. */
export interface Render {
  key: string;
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
  frames: number;
  /** Ogg, base64; none: silent. */
  sound: string | null;
  /** A montage's clips: how long each shows, seconds. */
  clips: number[];
}

/** What `video_list` answers: the mod's videos (and how long each lasts), and its pictures. */
export interface VideoList {
  own: string[];
  seconds: number[];
  images: string[];
}

export const NO_MEDIA: VideoList = { own: [], seconds: [], images: [] };

/** Frames kept per render, the oldest let go first. */
const KEPT_FRAMES = 240;

/** The videos and pictures a `.yvideo` of the mod at `path` can show (`@Videos.intro`). */
export function videoList(path: string): Promise<VideoList> {
  return cli<VideoList>(serveMethod.VIDEO_LIST, { path });
}

/** Video `video` (as edited) of the `.yvideo` at `path`, rendered. */
export function render(path: string, video: unknown): Promise<Render> {
  return cli<Render>(serveMethod.VIDEO_PREVIEW, { path, value: video });
}

/** Seconds a frame of `r` shows. */
export function frameSeconds(r: Render): number {
  return r.fps_den / Math.max(1, r.fps_num);
}

/** A picture from PNG bytes (base64). */
function image(png: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("a frame that isn't PNG"));
    img.src = `data:image/png;base64,${png}`;
  });
}

/** A render's frames, fetched one at a time (the CLI decodes in order) and kept. */
export class Frames {
  private kept = new Map<number, HTMLImageElement>();
  private asking: number | null = null;

  constructor(private readonly r: Render) {}

  /** Frame `n` if it's here; else asked for (one at a time), `ready` called when it comes. */
  get(n: number, ready: () => void): HTMLImageElement | undefined {
    const hit = this.kept.get(n);
    if (hit || this.asking !== null) return hit;
    this.asking = n;
    void cli<{ png: string }>(serveMethod.VIDEO_FRAME, { key: this.r.key, frame: n })
      .then((f) => image(f.png))
      .then((img) => {
        this.kept.set(n, img);
        if (this.kept.size > KEPT_FRAMES) this.kept.delete(this.kept.keys().next().value as number);
      })
      .catch(() => undefined)
      .finally(() => {
        this.asking = null;
        ready();
      });
    return undefined;
  }

  /** The kept frame nearest before `n` (shown while `n` comes). */
  before(n: number): HTMLImageElement | undefined {
    for (let i = n; i >= 0; i--) {
      const img = this.kept.get(i);
      if (img) return img;
    }
    return undefined;
  }
}

/** `r`'s sound, decoded (none: it's silent). */
export async function soundOf(r: Render): Promise<AudioBuffer | null> {
  if (!r.sound) return null;
  return decodeSound(bytesOf(r.sound));
}

/** Plays `buffer` from `offset` seconds at `volume`: stop it. */
export function playFrom(buffer: AudioBuffer, offset: number, volume: number): () => void {
  const ctx = audioContext();
  void ctx.resume();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  src.connect(gain).connect(ctx.destination);
  src.start(0, Math.min(offset, buffer.duration));
  return () => src.stop();
}
