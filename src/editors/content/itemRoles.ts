// What an item is — a tool, armor, worn, durable — set so the item stays one
// the build takes: a tool or armor (not both), armor already worn (no
// `wearable` beside it), durable stacking to 1 (no stack size beside it).

import type { ArmorSlot, ItemProps } from "../../content/model";

/** The material a new tool or armor starts with. */
const DEFAULT_MATERIAL = "iron";

/** `x` a tool of `kind` (undefined: not a tool): no longer armor. */
export function setToolKind(x: ItemProps, kind: string | undefined): void {
  if (kind === undefined) {
    delete x.tool;
    return;
  }
  x.tool = { material: DEFAULT_MATERIAL, ...(x.tool ?? {}), kind };
  delete x.armor;
}

/** `x` armor for `slot` (undefined: not armor): no longer a tool, and worn as armor is. */
export function setArmorSlot(x: ItemProps, slot: ArmorSlot | undefined): void {
  if (slot === undefined) {
    delete x.armor;
    return;
  }
  x.armor = { material: DEFAULT_MATERIAL, ...(x.armor ?? {}), slot };
  delete x.tool;
  delete x.wearable;
}

/** `x` worn in `slot` without being armor (undefined: not worn): no longer armor. */
export function setWearable(x: ItemProps, slot: ArmorSlot | undefined): void {
  if (slot === undefined) {
    delete x.wearable;
    return;
  }
  x.wearable = slot;
  delete x.armor;
}

/** `x`'s durability (undefined: none): a durable item stacks to 1, so its stack size goes. */
export function setDurability(x: ItemProps, durability: number | undefined): void {
  if (durability === undefined) {
    delete x.durability;
    return;
  }
  x.durability = durability;
  delete x.stack_size;
}
