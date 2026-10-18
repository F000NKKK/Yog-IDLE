import { list, num } from "../../data/values";
// The `.ydef` kinds (`yog_formats::def::Def`) as their designers see them:
// the file read and written back in place, the game's vocabularies the
// format names in its docs, and what the designers compute to draw —
// an advancement tab's layout, loot odds, a potion's color.

import type { DataFormat } from "../../data/useDataFile";
import { readObject } from "../../data/yogData";

export type DefFile = Record<string, unknown> & { kind?: string; id?: string };

/** A `.ydef` read and written through the CLI. */
export const DEF_FORMAT: DataFormat<DefFile> = { read: readObject<DefFile> };

export const asList = list;

// ── The game's vocabularies, as the format documents them ──────────────────

/** An advancement's frame. */
export const FRAMES = ["task", "goal", "challenge"] as const;
/** What earns an advancement: one of these per criterion. */
export const CRITERIA = ["granted", "has_item", "used_item"] as const;
export type Criterion = (typeof CRITERIA)[number];
/** `EffectCategory`. */
export const EFFECT_CATEGORIES = ["beneficial", "harmful", "neutral"] as const;
/** `ModifierOperation`. */
export const OPERATIONS = ["add", "multiply_base", "multiply_total"] as const;
export type Operation = (typeof OPERATIONS)[number];
/** A damage type's scaling, sound and death message (the game's). */
export const DAMAGE_SCALING = ["never", "always", "when_caused_by_living_non_player"] as const;
export const DAMAGE_EFFECTS = ["hurt", "thorns", "drowning", "burning", "poking", "freezing"] as const;
export const DEATH_MESSAGE_TYPES = ["default", "fall_variants", "intentional_game_design"] as const;
/** The game's trunk and foliage placers by short name (a mod's by id). */
export const TRUNK_SHAPES = ["straight", "forking", "giant", "mega_jungle", "dark_oak", "fancy", "bending", "upwards_branching", "cherry"] as const;
export const FOLIAGE_SHAPES = ["blob", "spruce", "pine", "acacia", "bush", "fancy", "jungle", "mega_pine", "dark_oak", "random_spread", "cherry"] as const;
/** Foliage shapes that take a `height`. */
export const FOLIAGE_WITH_HEIGHT = ["blob", "fancy", "bush", "jungle"] as const;
/** Kinds of content a tag groups; any of the game's registries by name too. */
export const TAG_KINDS = ["item", "block", "entity", "fluid", "biome", "damage_type"] as const;

// ── Advancements: a tab laid out as the game does ───────────────────────────

export interface AdvNode {
  id: string;
  parent: string | null;
}

/** The root an advancement hangs under, among `nodes` (itself if it has none there). */
export function rootOf(nodes: readonly AdvNode[], id: string): string {
  let cur = id;
  for (let i = 0; i < 256; i++) {
    const p = nodes.find((n) => n.id === cur)?.parent;
    if (!p || !nodes.some((n) => n.id === p)) return cur;
    cur = p;
  }
  return cur;
}

/** The nodes of `root`'s tab. */
export function tabOf(nodes: readonly AdvNode[], root: string): AdvNode[] {
  return nodes.filter((n) => rootOf(nodes, n.id) === root);
}

/** Which way a criterion earns it. */
export function criterionKind(c: Record<string, unknown>): Criterion {
  if (c.has_item !== undefined) return "has_item";
  if (c.used_item !== undefined) return "used_item";
  return "granted";
}

// ── Loot ────────────────────────────────────────────────────────────────────

export interface LootAdd {
  item?: string;
  count?: [number, number];
  chance?: number;
  function?: string;
}

/** A loot entry's count range (`[1, 1]` by default), low first. */
export function countRange(a: LootAdd): [number, number] {
  const c = Array.isArray(a.count) ? a.count : [1, 1];
  const lo = num(c[0], 1);
  const hi = num(c[1], lo);
  return [Math.min(lo, hi), Math.max(lo, hi)];
}

/** Its chance to be added at all (1 by default), 0–1. */
export const chanceOf = (a: LootAdd) => Math.min(Math.max(num(a.chance, 1), 0), 1);

/**
 * How many it adds a roll on average — as `LootModifier::apply`: a count
 * picked evenly from the range (below 1 adds none), at its chance.
 */
export function expectedCount(a: LootAdd): number {
  const [lo, hi] = countRange(a);
  let sum = 0;
  for (let n = lo; n <= hi; n++) sum += Math.max(n, 0);
  return (chanceOf(a) * sum) / (hi - lo + 1);
}

/** The chance it adds at least one, 0–1. */
export function chanceOfAny(a: LootAdd): number {
  const [lo, hi] = countRange(a);
  const positive = Math.max(0, hi - Math.max(lo, 1) + 1);
  return (chanceOf(a) * positive) / (hi - lo + 1);
}

// ── Effects ─────────────────────────────────────────────────────────────────

/** A modifier's amount as the game's tooltips write it: `+20%` multiplying, `+0.5` adding. */
export function modifierText(amount: number, op: Operation): string {
  const v = op === "add" ? Math.round(amount * 100) / 100 : Math.round(amount * 1000) / 10;
  return `${amount >= 0 ? "+" : ""}${v}${op === "add" ? "" : "%"}`;
}

// ── Trees ───────────────────────────────────────────────────────────────────

export interface WeightedBlock {
  block?: string;
  weight?: number;
}

/** Each block's share of a weighted list, 0–1 (weight 1 by default). */
export function shares(blocks: readonly WeightedBlock[]): number[] {
  const w = blocks.map((b) => Math.max(num(b.weight, 1), 0));
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  return w.map((x) => x / sum);
}

/** A trunk's height range: its base, plus up to both random parts. */
export function trunkHeights(trunk: Record<string, unknown>): [number, number] {
  const base = num(trunk.base_height);
  return [base, base + num(trunk.random_a) + num(trunk.random_b)];
}
