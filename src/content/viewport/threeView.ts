// The three.js objects that live as long as the view: scene, cameras, grid,
// compass, axes gizmo.

import * as THREE from "three";
import { BLOCK_PIXELS } from "../model";
import { type AnimatedTexture, AXIS_COLORS, boxEdges, CENTER, checkerTexture, label } from "./scene";
import { axisVector, DEFAULT_DISTANCE, FAR, FOV, NEAR, ORTHO_DEPTH, type OrbitCam } from "./camera";

/** The grid around the block: three blocks wide, a line per block. */
const OUTER_GRID = BLOCK_PIXELS * 3;
const GRID_COLOR = 0x5a5a5a;
const GRID_SUB_COLOR = 0x3a3a3a;
const OUTER_GRID_COLOR = 0x4a4a4a;
const BOUNDS_COLOR = 0x505050;
const NORTH_COLOR = "#555";
/** The compass label, just past the grid's north edge. */
const NORTH_OFFSET = 1.5;
/** The axes gizmo's camera: half its extent, and depth. */
const AXES_HALF = 1.6;
const AXES_DEPTH = 10;
/** The axes' labels, just past their ends. */
const AXIS_LABEL_AT = 1.2;
/** Where the camera starts: three quarters around, a third down from the top. */
const START_THETA = Math.PI * 0.75;
const START_PHI = Math.PI / 3;
const AXES = ["x", "y", "z"] as const;

/** A CSS color for a three.js one. */
export function cssHex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function grid(): THREE.Group {
  const group = new THREE.Group();
  const inner = new THREE.GridHelper(BLOCK_PIXELS, BLOCK_PIXELS, GRID_COLOR, GRID_SUB_COLOR);
  const outer = new THREE.GridHelper(OUTER_GRID, OUTER_GRID / BLOCK_PIXELS, OUTER_GRID_COLOR, OUTER_GRID_COLOR);
  inner.position.set(BLOCK_PIXELS / 2, 0, BLOCK_PIXELS / 2);
  outer.position.set(BLOCK_PIXELS / 2, 0, BLOCK_PIXELS / 2);
  group.add(inner, outer, boxEdges([0, 0, 0], [BLOCK_PIXELS, BLOCK_PIXELS, BLOCK_PIXELS], BOUNDS_COLOR));
  return group;
}

function axesScene(): THREE.Scene {
  const scene = new THREE.Scene();
  for (const [i, name] of AXES.entries()) {
    const dir = axisVector(i);
    const color = AXIS_COLORS[name];
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir]), new THREE.LineBasicMaterial({ color })));
    const l = label(name.toUpperCase(), cssHex(color));
    l.position.copy(dir.clone().multiplyScalar(AXIS_LABEL_AT));
    scene.add(l);
  }
  return scene;
}

/** The view's lasting objects, and what the draw loop keeps between frames. */
export function createThree() {
  const scene = new THREE.Scene();
  const model = new THREE.Group();
  const overlay = new THREE.Group();
  const gridGroup = grid();
  scene.add(gridGroup, model, overlay);
  // North marker under the grid's north edge — a compass label, kept at a
  // fixed on-screen size each frame (see NORTH_MARKER_PX) rather than
  // scaling with the model.
  const north = label("N", NORTH_COLOR);
  north.position.set(BLOCK_PIXELS / 2, 0, -NORTH_OFFSET);
  gridGroup.add(north);
  const cam: OrbitCam = { theta: START_THETA, phi: START_PHI, dist: DEFAULT_DISTANCE, target: CENTER.clone() };
  return {
    scene,
    persp: new THREE.PerspectiveCamera(FOV, 1, NEAR, FAR),
    orth: new THREE.OrthographicCamera(-BLOCK_PIXELS, BLOCK_PIXELS, BLOCK_PIXELS, -BLOCK_PIXELS, -ORTHO_DEPTH, ORTHO_DEPTH),
    model,
    overlay,
    grid: gridGroup,
    axesScene: axesScene(),
    axesCam: new THREE.OrthographicCamera(-AXES_HALF, AXES_HALF, AXES_HALF, -AXES_HALF, -AXES_DEPTH, AXES_DEPTH),
    north,
    checker: checkerTexture(),
    cam,
    handles: [] as THREE.Object3D[],
    renderer: null as THREE.WebGLRenderer | null,
    frame: 0,
    /** Animated textures in the scene: shown frame set each draw. */
    animated: [] as AnimatedTexture[],
    /** The timer that redraws when an animation's frame changes. */
    tick: 0,
  };
}

export type ThreeView = ReturnType<typeof createThree>;
