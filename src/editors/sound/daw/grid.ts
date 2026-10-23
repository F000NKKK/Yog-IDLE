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

/** Tracks' colours when a track has none: the theme's symbol colours. */
const PALETTE = [
  "--sp-symbol-function",
  "--sp-symbol-type",
  "--sp-symbol-constant",
  "--sp-symbol-field",
  "--sp-symbol-module",
  "--sp-symbol-interface",
  "--sp-git-added",
  "--sp-accent",
];
/** A colour channel's largest value; a colour's hex digits. */
const CHANNEL = 255;
const HEX = 16;
const HEX_DIGITS = 6;

/** Track `n`'s colour as CSS: its own (`0xRRGGBB`), else the theme's for it. */
export function trackColor(color: number | undefined, n: number): string {
  return color !== undefined ? css(color) : `var(${PALETTE[n % PALETTE.length]})`;
}

/** `0xRRGGBB` as CSS. */
export const css = (c: number) => `#${c.toString(HEX).padStart(HEX_DIGITS, "0")}`;

/** CSS colour `value` (a theme's variable too) as `#rrggbb`, as a colour picker takes it. */
export function hexOf(value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number) ?? [];
  probe.remove();
  const [r = 0, g = 0, b = 0] = rgb;
  return css((Math.round(r) << 16) | (Math.round(g) << 8) | Math.min(CHANNEL, Math.round(b)));
}
