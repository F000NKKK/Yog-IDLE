// The view's orbit camera: where it looks from, and how far it may go.

import * as THREE from "three";

/** The orbit: angle around Y from +Z (`theta`), from +Y (`phi`), distance, and what it looks at. */
export interface OrbitCam {
  theta: number;
  phi: number;
  dist: number;
  target: THREE.Vector3;
}

/** The camera's distance at first and after Home, in model pixels. */
export const DEFAULT_DISTANCE = 40;
export const MIN_DISTANCE = 4;
export const MAX_DISTANCE = 400;
/** Radians per pixel of an orbit drag. */
export const ORBIT_SPEED = 0.01;
/** Pan per pixel, as a share of the distance. */
export const PAN_SPEED = 0.0018;
/** Zoom per wheel unit (exponential). */
export const ZOOM_SPEED = 0.001;
/** A numpad 4/6/8/2 step: 15°. */
export const NUMPAD_STEP = Math.PI / 12;
/** The orthographic view's half height, as a share of the distance. */
export const ORTHO_HALF = 0.42;
/** How close to straight up/down the camera may look (radians) — at the pole the view would flip. */
const POLE_MARGIN = 0.01;
/** The perspective camera's field of view, and its near/far planes. */
export const FOV = 45;
export const NEAR = 0.1;
export const FAR = 2000;
/** The orthographic camera's depth range. */
export const ORTHO_DEPTH = 1000;

/** `phi` kept off the poles. */
export function clampPhi(phi: number): number {
  return Math.min(Math.PI - POLE_MARGIN, Math.max(POLE_MARGIN, phi));
}

/** The camera's position relative to its target. */
export function cameraOffset({ theta, phi, dist }: OrbitCam): THREE.Vector3 {
  return new THREE.Vector3(Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta)).multiplyScalar(dist);
}

/** The unit vector along model axis `axis` (0 = X, 1 = Y, 2 = Z). */
export function axisVector(axis: number): THREE.Vector3 {
  return new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
}
