// The montage's grid, as a music program's: bars and beats at the mix's
// tempo, and what a drag snaps to.

/** What a drag snaps to: a bar, a beat, a half or a quarter of one (a step), nothing. */
export type Snap = "bar" | "beat" | "half" | "step" | "none";

export const SNAPS: readonly Snap[] = ["bar", "beat", "half", "step", "none"];

/** Parts of a beat each snap is. */
const PER_BEAT: Record<Exclude<Snap, "bar" | "none">, number> = { beat: 1, half: 2, step: 4 };
const SECONDS_A_MINUTE = 60;

/** Seconds a beat lasts at `tempo` (beats a minute). */
export const beatSeconds = (tempo: number) => SECONDS_A_MINUTE / tempo;

/** Seconds of one snap at `tempo`, `beatsPerBar` a bar; 0: none. */
export function snapSeconds(snap: Snap, tempo: number, beatsPerBar: number): number {
  if (snap === "none") return 0;
  if (snap === "bar") return beatSeconds(tempo) * beatsPerBar;
  return beatSeconds(tempo) / PER_BEAT[snap];
}

/** `t` seconds snapped. */
export function snapped(t: number, snap: Snap, tempo: number, beatsPerBar: number): number {
  const s = snapSeconds(snap, tempo, beatsPerBar);
  return s > 0 ? Math.round(t / s) * s : t;
}

/** `t` seconds as `bar:beat:step` (from 1, as a music program counts). */
export function barBeat(t: number, tempo: number, beatsPerBar: number): string {
  const beats = t / beatSeconds(tempo);
  const bar = Math.floor(beats / beatsPerBar) + 1;
  const beat = (Math.floor(beats) % beatsPerBar) + 1;
  const step = Math.floor((beats % 1) * PER_BEAT.step) + 1;
  return `${bar}:${beat}:${step}`;
}

/** Tracks' colours when a track has none: a music program's pastels. */
const PALETTE = [0x5fb2e8, 0x8cd06a, 0xe8b45f, 0xe8738c, 0xb08ce8, 0x5fd6c2, 0xe8d65f, 0xc28a6a];

/** Track `n`'s colour (`0xRRGGBB`), its own or the palette's. */
export const trackColor = (color: number | undefined, n: number) => color ?? PALETTE[n % PALETTE.length];

/** `0xRRGGBB` as CSS. */
export const css = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
