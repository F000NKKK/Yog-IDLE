// A `.ysound` montage played as the build renders it (`yog-cli`'s `mix.rs`,
// one ffmpeg graph): each clip's sound cut, reversed, sped up (its pitch
// with it), made louder or quieter, faded, given its effects and placed;
// all mixed, the mix's effects over it.

/** An effect a sound goes through (`yog_formats::montage::SoundEffect`). */
export type SoundEffect = { fx: "echo"; delay: number; decay: number } | { fx: "low_pass"; hz: number } | { fx: "high_pass"; hz: number };

/** A part of a sound placed in a mix (`SoundClip`). */
export interface SoundClip {
  track?: number;
  sound?: string;
  file?: string;
  at?: number;
  from?: number;
  to?: number;
  gain?: number;
  fade_in?: number;
  fade_out?: number;
  speed?: number;
  reverse?: boolean;
  effects?: SoundEffect[];
}

/** A track and its mixer channel (`Track`). */
export interface Track {
  name?: string;
  color?: number;
  gain?: number;
  mute?: boolean;
  solo?: boolean;
  effects?: SoundEffect[];
}

/** A sound made of clips on tracks (`Mix`). */
export interface Mix {
  tempo?: number;
  beats_per_bar?: number;
  tracks?: Track[];
  clips: SoundClip[];
  gain?: number;
  effects?: SoundEffect[];
}

/** Whether track `n` is heard: not muted, and soloed when any track is (`Mix::heard`). */
export function heard(mix: Mix, n: number): boolean {
  const tracks = mix.tracks ?? [];
  const soloed = tracks.some((t) => t.solo);
  const t = tracks[n];
  return t ? !t.mute && (!!t.solo || !soloed) : !soloed;
}

/** An echo's loudness in and out, as ffmpeg's `aecho` the build uses. */
const ECHO_IN = 0.8;
const ECHO_OUT = 0.9;
/** ffmpeg's `lowpass`/`highpass`: two poles, Butterworth. */
const BUTTERWORTH_Q = Math.SQRT1_2;

/** The sound a clip plays, as `sound_data` takes it. */
export const clipSound = (c: SoundClip) => c.sound ?? c.file ?? "";

/** Clip `c`'s sound `b` cut to its part, reversed if it plays backwards. */
export function clipBuffer(ctx: BaseAudioContext, b: AudioBuffer, c: SoundClip): AudioBuffer {
  const start = Math.max(0, Math.floor((c.from ?? 0) * b.sampleRate));
  const end = Math.min(b.length, Math.floor((c.to ?? b.duration) * b.sampleRate));
  const out = ctx.createBuffer(b.numberOfChannels, Math.max(1, end - start), b.sampleRate);
  for (let ch = 0; ch < b.numberOfChannels; ch++) {
    const part = b.getChannelData(ch).slice(start, Math.max(start + 1, end));
    if (c.reverse) part.reverse();
    out.copyToChannel(part, ch);
  }
  return out;
}

/** How long clip `c` plays in the mix, seconds, its sound `b`. */
export function clipLength(b: AudioBuffer, c: SoundClip): number {
  const to = Math.min(c.to ?? b.duration, b.duration);
  return Math.max(0, to - (c.from ?? 0)) / (c.speed ?? 1);
}

/** `effects` chained after `input`: the chain's end. */
function effectChain(ctx: BaseAudioContext, input: AudioNode, effects: SoundEffect[] = []): AudioNode {
  let at = input;
  for (const e of effects) {
    if (e.fx === "echo") {
      const out = ctx.createGain();
      out.gain.value = ECHO_OUT;
      const dry = ctx.createGain();
      dry.gain.value = ECHO_IN;
      const delay = ctx.createDelay(Math.max(1, e.delay + 1));
      delay.delayTime.value = e.delay;
      const wet = ctx.createGain();
      wet.gain.value = e.decay;
      at.connect(dry).connect(out);
      at.connect(delay).connect(wet).connect(out);
      at = out;
    } else {
      const f = ctx.createBiquadFilter();
      f.type = e.fx === "low_pass" ? "lowpass" : "highpass";
      f.frequency.value = e.hz;
      f.Q.value = BUTTERWORTH_Q;
      at = at.connect(f);
    }
  }
  return at;
}

/** What a mix plays through: each track's channel and the master, each with a level meter. */
export interface Channels {
  tracks: Map<number, AnalyserNode>;
  master: AnalyserNode;
}

/** A channel: `gain`, then `effects`, metered, into `out`; its input. */
function channel(ctx: BaseAudioContext, gain: number, effects: SoundEffect[] | undefined, out: AudioNode): { input: GainNode; meter: AnalyserNode } {
  const input = ctx.createGain();
  input.gain.value = gain;
  const meter = ctx.createAnalyser();
  effectChain(ctx, input, effects).connect(meter).connect(out);
  return { input, meter };
}

/**
 * `mix` played into `out` from `start` (the context's time), its clips'
 * sounds `buffers` (in order; a missing one is left out): its sources (to
 * stop it) and channels (to meter it) — clips through their tracks'
 * channels, the heard tracks through the master, as the build mixes.
 */
export function playMix(
  ctx: BaseAudioContext,
  mix: Mix,
  buffers: (AudioBuffer | null)[],
  out: AudioNode,
  start: number,
  /** Seconds into the mix it starts from. */
  offset = 0,
): { sources: AudioBufferSourceNode[]; channels: Channels } {
  const master = channel(ctx, mix.gain ?? 1, mix.effects, out);
  const tracks = new Map<number, { input: GainNode; meter: AnalyserNode }>();
  const trackIn = (n: number) => {
    let t = tracks.get(n);
    if (!t) {
      const def = mix.tracks?.[n];
      t = channel(ctx, def?.gain ?? 1, def?.effects, master.input);
      tracks.set(n, t);
    }
    return t.input;
  };
  const sources: AudioBufferSourceNode[] = [];
  mix.clips.forEach((c, i) => {
    const b = buffers[i];
    const n = c.track ?? 0;
    if (!b || !heard(mix, n)) return;
    const src = ctx.createBufferSource();
    src.buffer = clipBuffer(ctx, b, c);
    src.playbackRate.value = c.speed ?? 1;
    const gain = ctx.createGain();
    const at = start + (c.at ?? 0) - offset, length = clipLength(b, c), level = c.gain ?? 1;
    // Over before the offset: not heard.
    if (at + length <= start) return;
    gain.gain.setValueAtTime(c.fade_in ? 0 : level, at);
    if (c.fade_in) gain.gain.linearRampToValueAtTime(level, at + c.fade_in);
    if (c.fade_out) {
      gain.gain.setValueAtTime(level, Math.max(at, at + length - c.fade_out));
      gain.gain.linearRampToValueAtTime(0, at + length);
    }
    effectChain(ctx, src.connect(gain), c.effects).connect(trackIn(n));
    // Started before the offset: from where it is by then.
    src.start(Math.max(start, at), Math.max(0, start - at) * (c.speed ?? 1));
    sources.push(src);
  });
  return { sources, channels: { tracks: new Map([...tracks].map(([n, t]) => [n, t.meter])), master: master.meter } };
}

/** How long `mix` lasts, seconds (its last clip's end). */
export function mixLength(mix: Mix, buffers: (AudioBuffer | null)[]): number {
  return mix.clips.reduce((end, c, i) => {
    const b = buffers[i];
    return b ? Math.max(end, (c.at ?? 0) + clipLength(b, c)) : end;
  }, 0);
}

/** `mix` rendered, as the build will (for its waveform). */
export async function renderMix(mix: Mix, buffers: (AudioBuffer | null)[], sampleRate: number): Promise<AudioBuffer | null> {
  // As long as its clips, as the build's: an echo doesn't run past the end.
  const length = mixLength(mix, buffers);
  if (length <= 0) return null;
  const ctx = new OfflineAudioContext(2, Math.ceil(length * sampleRate), sampleRate);
  playMix(ctx, mix, buffers, ctx.destination, 0);
  return ctx.startRendering();
}
