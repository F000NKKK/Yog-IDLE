// Sounds for the sound designer: a `.ysound` variant's sound (the mod's
// `@Sounds.x`, or a file the game has) fetched through the CLI and decoded
// once; played as the game plays it — its volume, its pitch (which, as in
// the game, is its speed too); its waveform's peaks for drawing.

import { serveMethod } from "../../data/yogIds.generated";
import { cli } from "../../cli";

/** What `sound_data` answers. */
interface SoundData {
  data: string;
  mime: string;
}

let context: AudioContext | null = null;

/** The designer's one audio context (made when first played: browsers want a gesture). */
export function audioContext(): AudioContext {
  context ??= new AudioContext();
  return context;
}

const decoded = new Map<string, Promise<AudioBuffer>>();

/** Base64 as bytes. */
export function bytesOf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Sound `sound` (as the file names it) of the mod the file at `path` is in, decoded. */
export function loadSound(path: string, sound: string): Promise<AudioBuffer> {
  const key = `${path}\n${sound}`;
  let p = decoded.get(key);
  if (!p) {
    p = cli<SoundData>(serveMethod.SOUND_DATA, { path, sound }).then((d) => audioContext().decodeAudioData(bytesOf(d.data)));
    p.catch(() => decoded.delete(key));
    decoded.set(key, p);
  }
  return p;
}

/** Forgets the decoded sounds (the mod's `.yres` changed). */
export function forgetSounds() {
  decoded.clear();
}

/** A sound playing: stop it. */
export interface Playing {
  stop: () => void;
  ended: Promise<void>;
}

/** Plays `buffer` at `volume` and `pitch` (its speed too, as in the game). */
export function play(buffer: AudioBuffer, volume: number, pitch: number): Playing {
  const ctx = audioContext();
  void ctx.resume();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = pitch;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  src.connect(gain).connect(ctx.destination);
  const ended = new Promise<void>((resolve) => (src.onended = () => resolve()));
  src.start();
  return { stop: () => src.stop(), ended };
}

/** `buffer`'s loudest sample in each of `n` slices (all channels): its waveform. */
export function peaks(buffer: AudioBuffer, n: number): Float32Array {
  const out = new Float32Array(n);
  const per = Math.max(1, Math.floor(buffer.length / n));
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) {
      let max = 0;
      for (let j = i * per, end = Math.min(data.length, j + per); j < end; j++) max = Math.max(max, Math.abs(data[j]));
      out[i] = Math.max(out[i], max);
    }
  }
  return out;
}
