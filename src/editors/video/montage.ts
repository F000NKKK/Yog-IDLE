// A `.yvideo`'s montage as the designer edits it (`yog_formats::video::
// Montage`): picture clips on picture tracks — a higher track over a lower —
// and a sound mix. How long a clip shows is the CLI's to say (the render's
// `clips`), so the formula has one home.

import type { Mix } from "../sound/montage";

/** A video or a picture placed in a montage (`PictureClip`). */
export interface PictureClip {
  track?: number;
  video?: string;
  image?: string;
  at?: number;
  from?: number;
  to?: number;
  speed?: number;
  fade_in?: number;
  fade_out?: number;
  opacity?: number;
  gain?: number;
}

/** A picture track (`PictureTrack`). */
export interface PictureTrack {
  name?: string;
  color?: number;
  hidden?: boolean;
}

/** A montage (`Montage`). */
export interface Montage {
  tracks?: PictureTrack[];
  clips?: PictureClip[];
  sound?: Mix;
}

/** The schema's name of a picture clip, for its Properties rows. */
export const PICTURE_CLIP_DEF = "PictureClip";

/** A clip without what's left unset. */
export const tidy = (c: PictureClip): PictureClip => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined && v !== null)) as PictureClip;

/** `m` with picture track `n` changed by `patch` (the tracks before it made, empty). */
export function withPictureTrack(m: Montage, n: number, patch: Partial<PictureTrack>): Montage {
  const tracks = [...(m.tracks ?? [])];
  while (tracks.length <= n) tracks.push({});
  const next: PictureTrack = { ...tracks[n], ...patch };
  tracks[n] = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== false && v !== "")) as PictureTrack;
  return { ...m, tracks };
}

/** What a clip shows, for its label: `@Media.intro`. */
export const clipMedia = (c: PictureClip): string => c.video ?? c.image ?? "";
