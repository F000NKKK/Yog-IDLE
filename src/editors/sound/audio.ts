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

/** How long the device stays open once the last sound has ended. A stream
 *  kept open for good dies on some outputs (Bluetooth headphones: their
 *  latency, the sink suspending) and never comes back — a fresh one does. */
const IDLE_CLOSE_MS = 2000;
/** The rate sounds are decoded at (a playing one is resampled to the device's). */
const DECODE_RATE = 48000;

let context: AudioContext | null = null;
let users = 0;
let closing: number | undefined;
let decoder: OfflineAudioContext | null = null;

/** The audio device, opened for something to play (browsers want a gesture
 *  first): `release` it when that's done. */
export function openAudio(): { ctx: AudioContext; release: () => void } {
  window.clearTimeout(closing);
  if (!context || context.state === "closed") context = new AudioContext({ latencyHint: "playback" });
  void context.resume();
  users++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (--users === 0) closing = window.setTimeout(closeAudio, IDLE_CLOSE_MS);
  };
  return { ctx: context, release };
}

function closeAudio() {
  const c = context;
  context = null;
  void c?.close();
}

/** Decodes `bytes` without opening the device. */
export function decodeSound(bytes: ArrayBuffer): Promise<AudioBuffer> {
  decoder ??= new OfflineAudioContext(1, 1, DECODE_RATE);
  return decoder.decodeAudioData(bytes);
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
    p = cli<SoundData>(serveMethod.SOUND_DATA, { path, sound }).then((d) => decodeSound(bytesOf(d.data)));
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
  const { ctx, release } = openAudio();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = pitch;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  src.connect(gain).connect(ctx.destination);
  const ended = new Promise<void>((resolve) => (src.onended = () => (release(), resolve())));
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
