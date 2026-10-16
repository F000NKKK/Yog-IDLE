// The `.yblock` / `.yitem` format (see docs/blocks-items.md) as the model
// editor sees it: types, Minecraft's constraints, the templates' geometry,
// face UVs, display defaults, and the file's text form.

import { DataSyntaxError, formatData, parseDataValue, patchDataText } from "../data/yogData";

export type Dir = "down" | "up" | "north" | "south" | "west" | "east";
export const DIRS: Dir[] = ["down", "up", "north", "south", "west", "east"];
export type Vec3 = [number, number, number];
export type Uv = [number, number, number, number];
export type Axis = "x" | "y" | "z";

export interface Face {
  texture: string;
  uv?: Uv;
  rotation?: number;
  cullface?: Dir;
  tint?: number;
}

export interface Element {
  name?: string;
  from: Vec3;
  to: Vec3;
  rotation?: { axis: Axis; angle: number; origin?: Vec3; rescale?: boolean };
  shade?: boolean;
  faces: Partial<Record<Dir, Face>>;
}

export interface DisplayTransform {
  rotation?: Vec3;
  translation?: Vec3;
  scale?: Vec3;
}

export const DISPLAY_SLOTS = [
  "gui",
  "ground",
  "fixed",
  "head",
  "thirdperson_righthand",
  "thirdperson_lefthand",
  "firstperson_righthand",
  "firstperson_lefthand",
] as const;
export type DisplaySlot = (typeof DISPLAY_SLOTS)[number];

export interface Model {
  parent?: string;
  textures?: Record<string, string>;
  elements?: Element[];
  display?: Partial<Record<DisplaySlot, DisplayTransform>>;
  ambient_occlusion?: boolean;
  gui_light?: "front" | "side";
}

export interface BlockProps {
  hardness?: number;
  resistance?: number;
  sound?: string;
  light?: number;
  /** `pickaxe`… or a mod's tool tag (`@tag:block:mymod:mineable/hammer`); one or a list. */
  tool?: string | string[];
  /** `iron`… or a level of the tool ladder (`@level:mymod:mythril`, a `.ydef`). */
  tool_level?: string;
  requires_tool?: boolean;
  collision?: boolean;
  slipperiness?: number;
  shape?: "auto" | "full" | number[];
  render_layer?: string;
  drops?: "self" | "none" | { item?: string; count?: number | [number, number] };
  connect_groups?: string[];
  /** The inventory screen it opens: a `.yui` `<Screen id>`. */
  inventory?: string;
  redstone?: boolean;
  /** A yes/no property kept on while it gets redstone power. */
  powered?: string;
  /** A yes/no property a comparator reads. */
  comparator?: string;
  accepts_items?: boolean;
  occludes?: boolean;
  base?: string;
  set?: string;
  press_ticks?: number;
  triggered_by?: "everything" | "mobs";
}

export interface ItemProps {
  stack_size?: number;
  durability?: number;
  fire_resistant?: boolean;
  fuel_ticks?: number;
  food?: { nutrition: number; saturation?: number; always_edible?: boolean };
  tool?: { kind: string; material: string; attack_damage?: number; attack_speed?: number };
  armor?: { slot: ArmorSlot; material: string };
  wearable?: ArmorSlot;
  hangs?: { entity: string; size?: [number, number] };
}

export const ARMOR_SLOTS = ["head", "chest", "legs", "feet"] as const;
export type ArmorSlot = (typeof ARMOR_SLOTS)[number];

export interface StateRotation {
  x?: number;
  y?: number;
  weight?: number;
  uvlock?: boolean;
}

export interface ContentFile {
  id?: string;
  name?: string;
  tooltip?: string;
  register?: "auto" | "manual";
  kind?: string;
  block?: BlockProps;
  item?: ItemProps;
  model?: Model;
  item_model?: Model;
  /** Mods it needs (Yog or Java mod ids): without them it isn't there. */
  requires?: string[];
  /** Tags it's in: `yog:planks`, `minecraft:logs`, or the mod's own by bare name. */
  tags?: string[];
  states?: {
    rotations?: StateRotation[];
    connect?: { arm: Model; uvlock?: boolean };
    facing?: "horizontal" | "all";
    placement?: "toward" | "away";
    attach?: boolean;
    waterlogged?: boolean;
    uvlock?: boolean;
    /** Its own properties: name → values, the first the default. */
    properties?: Record<string, string[]>;
    /** More models, by name, for `variants`. */
    models?: Record<string, Model>;
    /** Conditions (`"energized=true,facing=up"`) → a name in `models`, or several picked at random; the first that matches wins. */
    variants?: Record<string, string | string[]>;
  };
  [key: string]: unknown;
}

export type Kind = "block" | "item";
export const kindOf = (path: string): Kind | null => (/\.yblock$/i.test(path) ? "block" : /\.yitem$/i.test(path) ? "item" : null);

/** The game's tools and tiers by short name; a mod's are `@tag:block:…` tags. */
export const TOOLS = ["pickaxe", "axe", "shovel", "hoe"];
/** The game's kinds of tool item (a mod's: its `@tag:block:…` mineable tag). */
export const TOOL_KINDS = [...TOOLS, "sword"];
export const FACINGS = ["horizontal", "all"] as const;
/** How the facings are shown (translated). */
export const FACING_LABELS: Record<(typeof FACINGS)[number], string> = { horizontal: "Horizontal (4 sides)", all: "Any of the six sides" };
export const PLACEMENTS = ["toward", "away"] as const;
export const TOOL_LEVELS = ["wood", "stone", "iron", "diamond", "netherite"];
export const RENDER_LAYERS = ["solid", "cutout", "cutout_mipped", "translucent"];
/** Element rotation angles Minecraft allows. */
export const ANGLES = [-45, -22.5, 0, 22.5, 45];

export interface Template {
  name: string;
  slots: string[];
  /** An item sprite (`generated`, `handheld`) — item models only. */
  sprite?: boolean;
}

export const TEMPLATES: Template[] = [
  { name: "cube_all", slots: ["all"] },
  { name: "cube_column", slots: ["end", "side"] },
  { name: "cube_bottom_top", slots: ["top", "bottom", "side"] },
  { name: "cube", slots: ["down", "up", "north", "south", "west", "east"] },
  { name: "orientable", slots: ["front", "side", "top"] },
  { name: "cross", slots: ["cross"] },
  { name: "generated", slots: ["layer0"], sprite: true },
  { name: "handheld", slots: ["layer0"], sprite: true },
];
export const templateOf = (parent?: string) => TEMPLATES.find((t) => t.name === parent);

const full = (faces: Partial<Record<Dir, string>>, cull = true): Element => ({
  from: [0, 0, 0],
  to: [16, 16, 16],
  faces: Object.fromEntries(
    Object.entries(faces).map(([d, tex]) => [d, { texture: tex!, ...(cull ? { cullface: d as Dir } : {}) }])
  ) as Element["faces"],
});

/** The elements a block template stands for (vanilla's own). */
export function templateElements(name: string): Element[] | null {
  switch (name) {
    case "cube_all":
      return [full({ down: "#all", up: "#all", north: "#all", south: "#all", west: "#all", east: "#all" })];
    case "cube_column":
      return [full({ down: "#end", up: "#end", north: "#side", south: "#side", west: "#side", east: "#side" })];
    case "cube_bottom_top":
      return [full({ down: "#bottom", up: "#top", north: "#side", south: "#side", west: "#side", east: "#side" })];
    case "cube":
      return [full({ down: "#down", up: "#up", north: "#north", south: "#south", west: "#west", east: "#east" })];
    case "orientable":
      return [full({ down: "#top", up: "#top", north: "#front", south: "#side", west: "#side", east: "#side" })];
    case "cross":
      return [
        {
          from: [0.8, 0, 8],
          to: [15.2, 16, 8],
          rotation: { origin: [8, 8, 8], axis: "y", angle: 45, rescale: true },
          shade: false,
          faces: { north: { uv: [0, 0, 16, 16], texture: "#cross" }, south: { uv: [0, 0, 16, 16], texture: "#cross" } },
        },
        {
          from: [8, 0, 0.8],
          to: [8, 16, 15.2],
          rotation: { origin: [8, 8, 8], axis: "y", angle: 45, rescale: true },
          shade: false,
          faces: { west: { uv: [0, 0, 16, 16], texture: "#cross" }, east: { uv: [0, 0, 16, 16], texture: "#cross" } },
        },
      ];
    default:
      return null;
  }
}

/** Minecraft's UV for a face without one: from the element's position. */
export function autoUv(dir: Dir, from: Vec3, to: Vec3): Uv {
  const [x1, y1, z1] = from;
  const [x2, y2, z2] = to;
  switch (dir) {
    case "down":
      return [x1, 16 - z2, x2, 16 - z1];
    case "up":
      return [x1, z1, x2, z2];
    case "north":
      return [16 - x2, 16 - y2, 16 - x1, 16 - y1];
    case "south":
      return [x1, 16 - y2, x2, 16 - y1];
    case "west":
      return [z1, 16 - y2, z2, 16 - y1];
    case "east":
      return [16 - z2, 16 - y2, 16 - z1, 16 - y1];
  }
}

/** The face's corners seen from outside: top-left, top-right, bottom-right, bottom-left. */
export function faceCorners(dir: Dir, from: Vec3, to: Vec3): Vec3[] {
  const [x1, y1, z1] = from;
  const [x2, y2, z2] = to;
  switch (dir) {
    case "north":
      return [[x2, y2, z1], [x1, y2, z1], [x1, y1, z1], [x2, y1, z1]];
    case "south":
      return [[x1, y2, z2], [x2, y2, z2], [x2, y1, z2], [x1, y1, z2]];
    case "west":
      return [[x1, y2, z1], [x1, y2, z2], [x1, y1, z2], [x1, y1, z1]];
    case "east":
      return [[x2, y2, z2], [x2, y2, z1], [x2, y1, z1], [x2, y1, z2]];
    case "up":
      return [[x1, y2, z1], [x2, y2, z1], [x2, y2, z2], [x1, y2, z2]];
    case "down":
      return [[x1, y1, z2], [x2, y1, z2], [x2, y1, z1], [x1, y1, z1]];
  }
}

/** Minecraft's face brightness with shading on. */
export const FACE_SHADE: Record<Dir, number> = { up: 1, down: 0.5, north: 0.8, south: 0.8, west: 0.6, east: 0.6 };

/** The display transforms a model inherits from vanilla's `block/block` or `item/generated|handheld`. */
export function defaultDisplay(kind: "block" | "generated" | "handheld"): Partial<Record<DisplaySlot, DisplayTransform>> {
  if (kind === "block") {
    return {
      gui: { rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] },
      ground: { rotation: [0, 0, 0], translation: [0, 3, 0], scale: [0.25, 0.25, 0.25] },
      fixed: { rotation: [0, 0, 0], translation: [0, 0, 0], scale: [0.5, 0.5, 0.5] },
      head: { rotation: [0, 0, 0], translation: [0, 0, 0], scale: [1, 1, 1] },
      thirdperson_righthand: { rotation: [75, 45, 0], translation: [0, 2.5, 0], scale: [0.375, 0.375, 0.375] },
      thirdperson_lefthand: { rotation: [75, 45, 0], translation: [0, 2.5, 0], scale: [0.375, 0.375, 0.375] },
      firstperson_righthand: { rotation: [0, 45, 0], translation: [0, 0, 0], scale: [0.4, 0.4, 0.4] },
      firstperson_lefthand: { rotation: [0, 225, 0], translation: [0, 0, 0], scale: [0.4, 0.4, 0.4] },
    };
  }
  const hand =
    kind === "handheld"
      ? {
          thirdperson_righthand: { rotation: [0, -90, 55] as Vec3, translation: [0, 4, 0.5] as Vec3, scale: [0.85, 0.85, 0.85] as Vec3 },
          thirdperson_lefthand: { rotation: [0, 90, -55] as Vec3, translation: [0, 4, 0.5] as Vec3, scale: [0.85, 0.85, 0.85] as Vec3 },
        }
      : {
          thirdperson_righthand: { rotation: [0, 0, 0] as Vec3, translation: [0, 3, 1] as Vec3, scale: [0.55, 0.55, 0.55] as Vec3 },
          thirdperson_lefthand: { rotation: [0, 0, 0] as Vec3, translation: [0, 3, 1] as Vec3, scale: [0.55, 0.55, 0.55] as Vec3 },
        };
  return {
    gui: {},
    ground: { rotation: [0, 0, 0], translation: [0, 2, 0], scale: [0.5, 0.5, 0.5] },
    head: { rotation: [0, 180, 0], translation: [0, 13, 7], scale: [1, 1, 1] },
    fixed: { rotation: [0, 180, 0], translation: [0, 0, 0], scale: [1, 1, 1] },
    ...hand,
    firstperson_righthand: { rotation: [0, -90, 25], translation: [1.13, 3.2, 1.13], scale: [0.68, 0.68, 0.68] },
    firstperson_lefthand: { rotation: [0, 90, -25], translation: [1.13, 3.2, 1.13], scale: [0.68, 0.68, 0.68] },
  };
}

// ── Text ─────────────────────────────────────────────────────────────────────

export type Parsed = { ok: true; file: ContentFile } | { ok: false; error: string };

/** Yog Data text (comments, trailing commas, unquoted keys — as `yog` reads it). */
export function parseContent(text: string): Parsed {
  try {
    const value = parseDataValue(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "The file must be one object." };
    return { ok: true, file: value as ContentFile };
  } catch (e) {
    return { ok: false, error: e instanceof DataSyntaxError ? `${e.line}:${e.col}: ${e.message}` : e instanceof Error ? e.message : String(e) };
  }
}

/** The file's text: two-space indent, short arrays/objects of scalars on one line (`"uv": [0, 0, 16, 16]`). */
export function serializeContent(file: ContentFile): string {
  return `${formatData(file, 0)}\n`;
}

/** `text` holding `file`: what changed rewritten as `serializeContent` writes it, the rest — comments too — as it was. */
export function patchContent(text: string, file: ContentFile): string {
  return patchDataText(text, file, formatData);
}

/** A deep copy (files are plain JSON). */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ── New files ────────────────────────────────────────────────────────────────

export function newBlockFile(name: string): string {
  return serializeContent({
    name,
    block: { hardness: 1.5, resistance: 6, sound: "stone", tool: "pickaxe" },
    model: { parent: "cube_all", textures: { all: "minecraft:block/stone" } },
  });
}

export function newItemFile(name: string): string {
  return serializeContent({
    name,
    item: { stack_size: 64 },
    model: { parent: "generated", textures: { layer0: "minecraft:item/apple" } },
  });
}

/** A block with its own item sprite (`item_model`). */
export function newBlockWithItemFile(name: string): string {
  return serializeContent({
    name,
    block: { hardness: 1.5, resistance: 6, sound: "stone", tool: "pickaxe" },
    model: { parent: "cube_all", textures: { all: "minecraft:block/stone" } },
    item_model: { parent: "generated", textures: { layer0: "minecraft:item/apple" } },
  });
}

/** `ruby_ore` → `Ruby Ore`. */
export const titleOf = (stem: string) =>
  stem
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
