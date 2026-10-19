// Dragging a move/resize handle: the axis as it lies on screen, and the
// element's new bounds, snapped to the pixel grid.

import * as THREE from "three";
import { type Element, ELEMENT_MAX, ELEMENT_MIN, type Vec3 } from "../model";
import { axisVector } from "./camera";
import { type Handle, stateMatrix } from "./scene";
import type { Part } from "./viewportTypes";

/** The snap: a pixel, a quarter with Shift, free (a thousandth) with Ctrl. */
const STEP = 1;
const FINE_STEP = 0.25;
const FREE_STEP = 0.001;
/** Coordinates keep three decimals. */
const PRECISION = 1000;
/** Shorter than this on screen (px per unit), an axis points at the camera — no drag. */
const MIN_SCREEN_LENGTH = 0.01;

/** A handle being dragged: which, the element as it was, where the drag started, and its axis on screen. */
export interface HandleDrag {
  handle: Handle;
  el: Element;
  start: { x: number; y: number };
  screenAxis: THREE.Vector2;
  pxPerUnit: number;
}

/** Starts dragging `handle` (hit at `object`) of `el` in `part`, seen by `camera` in `rect`: projects its axis onto the screen; `null` if it points at the camera. */
export function startHandleDrag({ object, handle }: { object: THREE.Object3D; handle: Handle }, el: Element, part: Part, { camera, rect }: { camera: THREE.Camera; rect: DOMRect }, start: { x: number; y: number }): HandleDrag | null {
  const world = new THREE.Vector3();
  object.getWorldPosition(world);
  const axisDir = axisVector(handle.axis).applyMatrix4(new THREE.Matrix4().extractRotation(stateMatrix(part.x, part.y)));
  const toScreen = (v: THREE.Vector3) => {
    const p = v.clone().project(camera);
    return new THREE.Vector2(((p.x + 1) / 2) * rect.width, ((1 - p.y) / 2) * rect.height);
  };
  const d = toScreen(world.clone().add(axisDir)).sub(toScreen(world));
  const len = d.length();
  if (len < MIN_SCREEN_LENGTH) return null;
  return { handle, el, start, screenAxis: d.normalize(), pxPerUnit: len };
}

const clampCoord = (v: number) => Math.min(ELEMENT_MAX, Math.max(ELEMENT_MIN, Math.round(v * PRECISION) / PRECISION));

/** The element's bounds with the pointer at `x`, `y`: moved along the axis, or one side resized. */
export function draggedBounds({ handle, el, start, screenAxis, pxPerUnit }: HandleDrag, x: number, y: number, fine: boolean, free: boolean): { from: Vec3; to: Vec3 } {
  const moved = new THREE.Vector2(x - start.x, y - start.y).dot(screenAxis) / pxPerUnit;
  const step = fine ? FINE_STEP : free ? FREE_STEP : STEP;
  const delta = Math.round(moved / step) * step;
  const from = [...el.from] as Vec3;
  const to = [...el.to] as Vec3;
  const i = handle.axis;
  if (handle.kind === "move") {
    const size = to[i] - from[i];
    from[i] = clampCoord(from[i] + delta);
    to[i] = from[i] + size;
    if (to[i] > ELEMENT_MAX) {
      to[i] = ELEMENT_MAX;
      from[i] = ELEMENT_MAX - size;
    }
  } else if (handle.side === 1) to[i] = clampCoord(Math.max(from[i], to[i] + delta));
  else from[i] = clampCoord(Math.min(to[i], from[i] + delta));
  return { from, to };
}
