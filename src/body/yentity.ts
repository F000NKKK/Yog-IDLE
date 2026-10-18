// The `.yentity` format (`yog_registry::EntityDef`, compiled by `yog build`'s
// `compile_entity`) as the entity designer sees it: what the file says, the
// sizes it's drawn at, and its text written back in place — comments and
// layout kept (`patchDataText`).

import type { DataFormat } from "../data/useDataFile";
import { readObject } from "../data/yogData";

/** What kind of entity a type is (`EntityKind`), in the format's order. */
export const ENTITY_KINDS = ["object", "living", "mob", "hanging"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** The game's spawn groups (`MobCategory`), `misc` the default. */
export const CATEGORIES = ["misc", "monster", "creature", "ambient", "water_creature", "water_ambient", "underground_water_creature"] as const;

/**
 * The game's AI goals the hosts make by name (`YogMob`'s goals; the loader
 * keeps no list of them, so the designer offers these — any other name is
 * kept as written).
 */
export const GAME_GOALS = ["float", "panic", "melee_attack", "wander", "look_at_player", "look_around", "target_player", "avoid_player"] as const;

/** States the game sets on its own (`yog:state` names the mod's). */
export const GAME_STATES = ["idle", "walk", "attack", "hurt", "death"] as const;

/** Attributes most mobs set, offered first (the game's by short name). */
export const COMMON_ATTRIBUTES = ["max_health", "movement_speed", "attack_damage", "follow_range", "armor", "knockback_resistance"] as const;

/** What the format takes when a field is left out (`EntityDef`'s defaults). */
export const ENTITY_DEFAULTS = {
  category: "misc",
  tracking_range: 8,
  update_interval: 3,
  /** A hanging thing's sounds: a painting's. */
  place_sound: "minecraft:entity.painting.place",
  break_sound: "minecraft:entity.painting.break",
} as const;

export interface EntityFile {
  id?: string;
  name?: string;
  kind?: EntityKind;
  category?: string;
  width?: number;
  height?: number;
  eye_height?: number;
  fire_immune?: boolean;
  no_gravity?: boolean;
  pushable?: boolean;
  solid?: boolean;
  tracking_range?: number;
  update_interval?: number;
  attributes?: Record<string, number>;
  model?: string;
  animations?: string;
  clips?: Record<string, string>;
  spawn_egg?: [number, number];
  goals?: string[];
  ticks?: boolean;
  place_sound?: string;
  break_sound?: string;
  [key: string]: unknown;
}

/** A `.yentity` read and written through the CLI. */
export const ENTITY_FORMAT: DataFormat<EntityFile> = { read: readObject<EntityFile> };

export const kindOf = (f: EntityFile): EntityKind => (ENTITY_KINDS.includes(f.kind as EntityKind) ? (f.kind as EntityKind) : "object");

/** Living things have attributes and clips by state; only mobs have goals. */
export const isLiving = (k: EntityKind) => k === "living" || k === "mob";

/** Its eye height, blocks: as given, else 85% of the height (the game's default). */
export const eyeHeight = (f: EntityFile) => f.eye_height ?? (f.height ?? 0) * 0.85;

/** Whether others push it: as given, else living things only. */
export const pushable = (f: EntityFile) => f.pushable ?? isLiving(kindOf(f));

/** A body file's id as an entity names it: the mod's own without its namespace (`body/wisp`), another's in full. */
export function bodyRef(id: string, ns: string): string {
  return id.startsWith(`${ns}:`) ? id.slice(ns.length + 1) : id;
}

/** A body reference (`body/wisp`, `mymod:body/wisp`) with its namespace. */
export function bodyId(ref: string, ns: string): string {
  return ref.includes(":") ? ref : `${ns}:${ref}`;
}

/** `list` with the item at `from` moved to `to`. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out;
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}
