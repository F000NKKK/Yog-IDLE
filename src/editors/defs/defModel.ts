import { list, num } from "../../data/values";
// The `.ydef` kinds (`yog_formats::def::Def`) as their designers see them:
// the file read and written back in place, the game's vocabularies the
// format names in its docs, and what the designers compute to draw —
// an advancement tab's layout, loot odds, a potion's color.

import { DataSyntaxError, formatData, parseDataValue, patchDataText } from "../../data/yogData";

export type DefFile = Record<string, unknown> & { kind?: string; id?: string };

export type Parsed = { ok: true; file: DefFile } | { ok: false; error: string };

export function parseDef(text: string): Parsed {
  if (!text.trim()) return { ok: true, file: {} };
  try {
    const v = parseDataValue(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "a definition is one object" };
    return { ok: true, file: v as DefFile };
  } catch (e) {
    return { ok: false, error: e instanceof DataSyntaxError ? `${e.line}:${e.col}: ${e.message}` : String(e) };
  }
}

/** `text` holding `file`: what changed rewritten, the rest — comments too — as it was. */
export function patchDef(text: string, file: DefFile): string {
  return patchDataText(text, file, formatData);
}

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

/**
 * Where the game's advancements screen puts each of a tab's advancements —
 * a port of Minecraft's `TreeNodePosition` (Walker's tidy tree): `x` the
 * column (its depth), `y` the row (may be fractional); the screen draws
 * one at `(floor(x·28), floor(y·27))`. Children in the order given.
 */
export function layoutTree(nodes: readonly AdvNode[]): Map<string, { x: number; y: number }> {
  const ids = new Set(nodes.map((n) => n.id));
  const childrenOf = new Map<string | null, string[]>();
  for (const n of nodes) {
    const p = n.parent && ids.has(n.parent) && n.parent !== n.id ? n.parent : null;
    childrenOf.set(p, [...(childrenOf.get(p) ?? []), n.id]);
  }
  const at = new Map<string, { x: number; y: number }>();
  // Each root's tree under the one before (the designer shows one tab; cycles may leave more).
  let offset = 0;
  for (const root of childrenOf.get(null) ?? []) {
    const tree = TreeNode.build(root, childrenOf);
    tree.firstWalk();
    const top = tree.secondWalk(0, 0, tree.y);
    if (top < 0) tree.thirdWalk(-top);
    let bottom = 0;
    tree.each((n) => {
      at.set(n.id, { x: n.x, y: n.y + offset });
      bottom = Math.max(bottom, n.y);
    });
    offset += bottom + 1;
  }
  // What a cycle left out: a column of its own.
  for (const n of nodes) if (!at.has(n.id)) at.set(n.id, { x: 0, y: offset++ });
  return at;
}

/** One advancement in `TreeNodePosition`'s walk. */
class TreeNode {
  ancestor: TreeNode = this;
  thread: TreeNode | null = null;
  children: TreeNode[] = [];
  y = -1;
  mod = 0;
  change = 0;
  shift = 0;

  private constructor(
    readonly id: string,
    readonly parent: TreeNode | null,
    readonly previousSibling: TreeNode | null,
    readonly childIndex: number,
    public x: number,
  ) {}

  static build(id: string, childrenOf: Map<string | null, string[]>): TreeNode {
    const root = new TreeNode(id, null, null, 1, 0);
    root.addChildren(childrenOf, new Set());
    return root;
  }

  private addChildren(childrenOf: Map<string | null, string[]>, seen: Set<string>) {
    seen.add(this.id);
    let previous: TreeNode | null = null;
    for (const c of childrenOf.get(this.id) ?? []) {
      if (seen.has(c)) continue;
      const child: TreeNode = new TreeNode(c, this, previous, this.children.length + 1, this.x + 1);
      this.children.push(child);
      child.addChildren(childrenOf, seen);
      previous = child;
    }
  }

  each(f: (n: TreeNode) => void) {
    f(this);
    for (const c of this.children) c.each(f);
  }

  firstWalk() {
    if (!this.children.length) {
      this.y = this.previousSibling ? this.previousSibling.y + 1 : 0;
      return;
    }
    let defaultAncestor: TreeNode | null = null;
    for (const child of this.children) {
      child.firstWalk();
      defaultAncestor = child.apportion(defaultAncestor ?? child);
    }
    this.executeShifts();
    const mid = (this.children[0].y + this.children[this.children.length - 1].y) / 2;
    if (this.previousSibling) {
      this.y = this.previousSibling.y + 1;
      this.mod = this.y - mid;
    } else {
      this.y = mid;
    }
  }

  secondWalk(offsetY: number, column: number, top: number): number {
    this.y += offsetY;
    this.x = column;
    if (this.y < top) top = this.y;
    for (const child of this.children) top = child.secondWalk(offsetY + this.mod, column + 1, top);
    return top;
  }

  thirdWalk(y: number) {
    this.y += y;
    for (const child of this.children) child.thirdWalk(y);
  }

  private executeShifts() {
    let shift = 0;
    let change = 0;
    for (let i = this.children.length - 1; i >= 0; i--) {
      const child = this.children[i];
      child.y += shift;
      child.mod += shift;
      change += child.change;
      shift += child.shift + change;
    }
  }

  private previousOrThread(): TreeNode | null {
    return this.thread ?? this.children[0] ?? null;
  }

  private nextOrThread(): TreeNode | null {
    return this.thread ?? this.children[this.children.length - 1] ?? null;
  }

  private apportion(defaultAncestor: TreeNode): TreeNode {
    if (!this.previousSibling || !this.parent) return defaultAncestor;
    let insideRight: TreeNode = this;
    let outsideRight: TreeNode = this;
    let insideLeft: TreeNode = this.previousSibling;
    let outsideLeft: TreeNode = this.parent.children[0];
    let sInsideRight = this.mod;
    let sOutsideRight = this.mod;
    let sInsideLeft = insideLeft.mod;
    let sOutsideLeft = outsideLeft.mod;
    while (insideLeft.nextOrThread() && insideRight.previousOrThread()) {
      insideLeft = insideLeft.nextOrThread()!;
      insideRight = insideRight.previousOrThread()!;
      outsideLeft = outsideLeft.previousOrThread()!;
      outsideRight = outsideRight.nextOrThread()!;
      outsideRight.ancestor = this;
      const gap = insideLeft.y + sInsideLeft - (insideRight.y + sInsideRight) + 1;
      if (gap > 0) {
        insideLeft.ancestorOf(this, defaultAncestor).moveSubtree(this, gap);
        sInsideRight += gap;
        sOutsideRight += gap;
      }
      sInsideLeft += insideLeft.mod;
      sInsideRight += insideRight.mod;
      sOutsideLeft += outsideLeft.mod;
      sOutsideRight += outsideRight.mod;
    }
    if (insideLeft.nextOrThread() && !outsideRight.nextOrThread()) {
      outsideRight.thread = insideLeft.nextOrThread();
      outsideRight.mod += sInsideLeft - sOutsideRight;
    } else {
      if (insideRight.previousOrThread() && !outsideLeft.previousOrThread()) {
        outsideLeft.thread = insideRight.previousOrThread();
        outsideLeft.mod += sInsideRight - sOutsideLeft;
      }
      defaultAncestor = this;
    }
    return defaultAncestor;
  }

  private ancestorOf(self: TreeNode, other: TreeNode): TreeNode {
    return self.parent?.children.includes(this.ancestor) ? this.ancestor : other;
  }

  private moveSubtree(node: TreeNode, shift: number) {
    const subtrees = node.childIndex - this.childIndex;
    if (subtrees !== 0) {
      node.change -= shift / subtrees;
      this.change += shift / subtrees;
    }
    node.shift += shift;
    node.y += shift;
    node.mod += shift;
  }
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
