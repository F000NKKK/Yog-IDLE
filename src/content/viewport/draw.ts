// Drawing one frame of the view: the camera placed, animated textures
// advanced, the scene, then the axes gizmo in a corner.

import * as THREE from "three";
import { frameNow, msToNextFrame } from "../animation";
import { cameraOffset, ORTHO_HALF } from "./camera";
import { NORTH_MARKER_PX, showFrame } from "./scene";
import type { ThreeView } from "./threeView";

/** The axes gizmo's square, in CSS px, and its inset from the corner. */
const AXES_SIZE = 80;
const AXES_INSET = 4;
/** How far from the origin the axes gizmo's camera sits. */
const AXES_CAMERA_DISTANCE = 5;
/** The soonest an animation redraw is scheduled, in ms. */
const MIN_TICK_MS = 10;

/** Places the active camera for a `w`×`h` view; returns it and its offset from the target. */
function placeCamera(three: ThreeView, ortho: boolean, w: number, h: number) {
  const offset = cameraOffset(three.cam);
  const camera = ortho ? three.orth : three.persp;
  if (ortho) {
    const half = three.cam.dist * ORTHO_HALF;
    three.orth.left = (-half * w) / h;
    three.orth.right = (half * w) / h;
    three.orth.top = half;
    three.orth.bottom = -half;
  } else three.persp.aspect = w / h;
  camera.position.copy(three.cam.target).add(offset);
  camera.up.set(0, 1, 0);
  camera.lookAt(three.cam.target);
  camera.updateProjectionMatrix();
  // The compass keeps its on-screen size.
  const unitsPerPx = ortho
    ? (three.orth.top - three.orth.bottom) / h
    : (2 * camera.position.distanceTo(three.north.getWorldPosition(new THREE.Vector3())) * Math.tan(THREE.MathUtils.degToRad(three.persp.fov / 2))) / h;
  three.north.scale.setScalar(NORTH_MARKER_PX * unitsPerPx);
  return { camera, offset };
}

/** Shows each animated texture's frame now (or the one held), and schedules a redraw when the next is due — 20 ticks a second, as in game. */
function advanceAnimations(three: ThreeView, invalidate: () => void) {
  const now = performance.now();
  let next = Infinity;
  for (const { texture, src, shapeOf } of three.animated) {
    const anim = src.animation;
    if (!anim) continue;
    const frame = src.pinned ?? frameNow(anim, now);
    showFrame(texture, anim, frame);
    shapeOf?.(frame);
    if (src.pinned === undefined && anim.frames.length > 1) next = Math.min(next, msToNextFrame(anim, now));
  }
  clearTimeout(three.tick);
  if (next < Infinity) three.tick = window.setTimeout(invalidate, Math.max(MIN_TICK_MS, next));
}

/** The axes gizmo, bottom-left, turned as the camera is. */
function drawAxes(three: ThreeView, renderer: THREE.WebGLRenderer, offset: THREE.Vector3) {
  three.axesCam.position.copy(offset.clone().normalize().multiplyScalar(AXES_CAMERA_DISTANCE));
  three.axesCam.lookAt(0, 0, 0);
  renderer.setViewport(AXES_INSET, AXES_INSET, AXES_SIZE, AXES_SIZE);
  renderer.setScissor(AXES_INSET, AXES_INSET, AXES_SIZE, AXES_SIZE);
  renderer.setScissorTest(true);
  renderer.clearDepth();
  renderer.render(three.axesScene, three.axesCam);
  renderer.setScissorTest(false);
}

/** Draws the view into `host`'s size. */
export function drawFrame(three: ThreeView, renderer: THREE.WebGLRenderer, host: HTMLElement, ortho: boolean, invalidate: () => void) {
  three.frame = 0;
  const w = host.clientWidth;
  const h = host.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  renderer.domElement.style.width = `${w}px`;
  renderer.domElement.style.height = `${h}px`;
  const { camera, offset } = placeCamera(three, ortho, w, h);
  advanceAnimations(three, invalidate);
  renderer.setViewport(0, 0, w, h);
  renderer.setScissorTest(false);
  renderer.clear();
  renderer.render(three.scene, camera);
  drawAxes(three, renderer, offset);
}
