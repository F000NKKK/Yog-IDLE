// How a block is placed — facing, placement, attaching, waterlogging — set so
// its states stay ones the build takes: these turn the block, so random
// rotations and connecting go; placement only with facing or attach; an
// attached block turns four ways, so no facing of all six sides.

import type { States } from "../../content/states";

type Facing = States["facing"];
type Placement = States["placement"];

/** Turning the block one of these ways: rotations and connecting go. */
function turns(s: States): void {
  delete s.rotations;
  delete s.connect;
}

/** Placement without facing or attach says nothing: it goes. */
function keepPlacement(s: States): void {
  if (s.facing === undefined && !s.attach) delete s.placement;
}

/** `s` facing `facing` (undefined: it doesn't turn). */
export function setFacing(s: States, facing: Facing): void {
  if (facing === undefined) delete s.facing;
  else {
    s.facing = facing;
    if (facing === "all") delete s.attach;
    turns(s);
  }
  keepPlacement(s);
}

/** `s` placed `placement`; none without facing or attach. */
export function setPlacement(s: States, placement: Placement): void {
  if (placement === undefined) delete s.placement;
  else s.placement = placement;
  keepPlacement(s);
}

/** `s` attaching to a floor, wall or ceiling (or not). */
export function setAttach(s: States, attach: boolean): void {
  if (attach) {
    s.attach = true;
    if (s.facing === "all") delete s.facing;
    turns(s);
  } else delete s.attach;
  keepPlacement(s);
}

/** `s` able to stand in water (or not). */
export function setWaterlogged(s: States, waterlogged: boolean): void {
  if (waterlogged) {
    s.waterlogged = true;
    turns(s);
  } else delete s.waterlogged;
}
