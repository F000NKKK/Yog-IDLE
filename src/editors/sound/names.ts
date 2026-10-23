// A sound's name as the designers show it: the mod's `@Sounds.cast.spell`
// as `cast.spell` in its set `Sounds`; the game's `minecraft:dig/sand1` as
// `dig/sand1` — not the reference the file writes.

/** What a reference to a mod's resource starts with. */
const RES = "@";
const GAME_NS = "minecraft:";

/** Sound `s` (as the file names it): its name, and the `.yres` set it's in (none: the game's). */
export function soundName(s: string): { name: string; set: string | null } {
  if (s.startsWith(RES)) {
    const ref = s.slice(RES.length);
    const dot = ref.indexOf(".");
    return dot < 0 ? { name: ref, set: null } : { name: ref.slice(dot + 1), set: ref.slice(0, dot) };
  }
  return { name: s.startsWith(GAME_NS) ? s.slice(GAME_NS.length) : s, set: null };
}

/** Sound `s`'s name alone. */
export const soundLabel = (s: string) => soundName(s).name;
