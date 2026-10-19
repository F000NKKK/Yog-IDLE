// The selected element's handles: arrows to move it along an axis, or cubes
// on each side to resize it.

import * as THREE from "three";
import type { Element } from "../model";
import { axisVector } from "./camera";
import { AXIS_COLORS, type Handle, stateMatrix } from "./scene";
import type { ThreeView } from "./threeView";
import type { GizmoMode, Part } from "./viewportTypes";

const AXES = ["x", "y", "z"] as const;
/** Drawn over everything else. */
const HANDLE_ORDER = 20;
/** A move arrow: its length past the element's half size, head length and width. */
const ARROW_REACH = 6;
const ARROW_HEAD = 1.6;
const ARROW_HEAD_WIDTH = 1;
/** The invisible pick cylinder along an arrow: radius and sides. */
const PICK_RADIUS = 0.8;
const PICK_SIDES = 6;
/** A resize cube's size, and its gap from the element's face. */
const CUBE_SIZE = 1;
const CUBE_GAP = 0.8;

/** Where an axis's handles go: the view, the handles' group, the element and its center. */
interface HandleSite {
  three: ThreeView;
  handles: THREE.Group;
  el: Element;
  center: THREE.Vector3;
}

/** Adds `el`'s handles (of the editable `part`) to the overlay, registering their pick targets. */
export function addHandles(three: ThreeView, el: Element, part: Part, gizmo: GizmoMode) {
  const handles = new THREE.Group();
  handles.matrixAutoUpdate = false;
  handles.matrix.copy(stateMatrix(part.x, part.y));
  const center = new THREE.Vector3((el.from[0] + el.to[0]) / 2, (el.from[1] + el.to[1]) / 2, (el.from[2] + el.to[2]) / 2);
  for (const axis of [0, 1, 2] as const) {
    const color = AXIS_COLORS[AXES[axis]];
    const at: HandleSite = { three, handles, el, center };
    if (gizmo === "move") moveArrow(at, axis, color);
    else resizeCubes(at, axis, color);
  }
  three.overlay.add(handles);
}

function moveArrow({ three, handles, el, center }: HandleSite, axis: 0 | 1 | 2, color: number) {
  const dir = axisVector(axis);
  const len = ARROW_REACH + Math.max(...el.to.map((t, i) => t - el.from[i])) / 2;
  const arrow = new THREE.ArrowHelper(dir, center, len, color, ARROW_HEAD, ARROW_HEAD_WIDTH);
  (arrow.line.material as THREE.LineBasicMaterial).depthTest = false;
  (arrow.cone.material as THREE.MeshBasicMaterial).depthTest = false;
  arrow.traverse((o) => (o.renderOrder = HANDLE_ORDER));
  // A fat invisible pick target along the arrow.
  const pick = new THREE.Mesh(new THREE.CylinderGeometry(PICK_RADIUS, PICK_RADIUS, len, PICK_SIDES), new THREE.MeshBasicMaterial({ visible: false }));
  pick.position.copy(center.clone().add(dir.clone().multiplyScalar(len / 2)));
  pick.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  pick.userData = { handle: { kind: "move", axis, side: 1 } satisfies Handle };
  handles.add(arrow, pick);
  three.handles.push(pick);
}

function resizeCubes({ three, handles, el, center }: HandleSite, axis: 0 | 1 | 2, color: number) {
  const dir = axisVector(axis);
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
  for (const side of [1, -1] as const) {
    const cube = new THREE.Mesh(new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE), mat);
    const p = center.clone();
    p.setComponent(axis, side === 1 ? el.to[axis] : el.from[axis]);
    p.add(dir.clone().multiplyScalar(side * CUBE_GAP));
    cube.position.copy(p);
    cube.renderOrder = HANDLE_ORDER;
    cube.userData = { handle: { kind: "resize", axis, side } satisfies Handle };
    handles.add(cube);
    three.handles.push(cube);
  }
}
