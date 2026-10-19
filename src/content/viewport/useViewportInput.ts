// The view's mouse and keyboard: middle/right (or Alt+left) drag orbits,
// Shift pans, the wheel zooms; a left click picks an element and face, a
// left drag on a handle moves or resizes it; in paint mode the left button
// paints. Numpad keys are `viewKey`'s.

import { type MutableRefObject, type RefObject, useEffect } from "react";
import * as THREE from "three";
import type { Dir, Vec3 } from "../model";
import { clampPhi, MAX_DISTANCE, MIN_DISTANCE, ORBIT_SPEED, PAN_SPEED, ZOOM_SPEED } from "./camera";
import { type MeshData, PART } from "./buildModel";
import { draggedBounds, type HandleDrag, startHandleDrag } from "./handleDrag";
import type { Handle } from "./scene";
import type { ThreeView } from "./threeView";
import { viewKey } from "./viewKeys";
import type { PaintHit, ViewportProps } from "./viewportTypes";

/** A press that moves less than this (px, Manhattan) is a click. */
const CLICK_SLOP = 4;
const MIDDLE = 1;
const RIGHT = 2;

/** The props the input reads at the moment of an event (kept in a ref, so the listeners aren't rebound each render). */
export type InputProps = Pick<ViewportProps, "parts" | "onSelect" | "onTransform" | "selected" | "onPaint">;

type Mode = "orbit" | "pan" | "handle" | "paint";

/** The pointer in normalized device coordinates. */
function ndc(host: HTMLElement, e: PointerEvent | MouseEvent): THREE.Vector2 {
  const r = host.getBoundingClientRect();
  return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
}

/** The texture pixel under the pointer on the editable part, in paint mode. */
function paintHit(three: ThreeView, raycaster: THREE.Raycaster): PaintHit | null {
  for (const hit of raycaster.intersectObjects(three.model.children, true)) {
    const data = hit.object.userData as MeshData;
    if (data.part !== PART.edit || !data.paint || !hit.uv) continue;
    const map = ((hit.object as THREE.Mesh).material as THREE.MeshBasicMaterial).map;
    const img = map?.image as { width?: number; height?: number } | undefined;
    if (!map || map === three.checker || !img?.width || !img.height) return null;
    // The pixel in the shown frame (UVs span one frame — `showFrame`).
    const w = Math.round(img.width * map.repeat.x);
    const h = Math.round(img.height * map.repeat.y);
    const pixel = (n: number, max: number) => Math.min(max - 1, Math.max(0, Math.floor(n)));
    return { slot: data.paint.slot, x: pixel(hit.uv.x * w, w), y: pixel((1 - hit.uv.y) * h, h), element: data.element ?? null, face: data.face ?? null };
  }
  return null;
}

/** What the input acts on: the view, the props it reads, and the view's own state. */
export interface InputTarget {
  hostRef: RefObject<HTMLDivElement | null>;
  three: ThreeView;
  ortho: boolean;
  propsRef: MutableRefObject<InputProps>;
  invalidate: MutableRefObject<() => void>;
  setDrag: (drag: { index: number; from: Vec3; to: Vec3 } | null) => void;
  setOrtho: (f: (o: boolean) => boolean) => void;
}

/** Wires the view's input to `hostRef` while it's mounted. */
export function useViewportInput({ hostRef, three, ortho, propsRef, invalidate, setDrag, setOrtho }: InputTarget) {
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const input = new ViewportInput(host, three, ortho ? three.orth : three.persp, propsRef, () => invalidate.current(), setDrag, () => setOrtho((o) => !o));
    return input.attach();
  }, [hostRef, three, ortho, propsRef, invalidate, setDrag, setOrtho]);
}

/** One binding of the input to the view (for one camera). */
class ViewportInput {
  private readonly raycaster = new THREE.Raycaster();
  private mode: Mode | null = null;
  private last = { x: 0, y: 0 };
  private down = { x: 0, y: 0 };
  private handleDrag: HandleDrag | null = null;
  private live: { from: Vec3; to: Vec3 } | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly three: ThreeView,
    private readonly camera: THREE.Camera,
    private readonly props: MutableRefObject<InputProps>,
    private readonly invalidate: () => void,
    private readonly setDrag: (drag: { index: number; from: Vec3; to: Vec3 } | null) => void,
    private readonly toggleOrtho: () => void,
  ) {}

  attach(): () => void {
    const listeners: [string, (e: never) => void, AddEventListenerOptions?][] = [
      ["pointerdown", this.onDown],
      ["pointermove", this.onMove],
      ["pointerup", this.onUp],
      ["wheel", this.onWheel, { passive: false }],
      ["keydown", this.onKey],
      ["contextmenu", (e: MouseEvent) => e.preventDefault()],
    ];
    for (const [type, fn, options] of listeners) this.host.addEventListener(type, fn as EventListener, options);
    return () => {
      for (const [type, fn] of listeners) this.host.removeEventListener(type, fn as EventListener);
    };
  }

  private aim(e: PointerEvent) {
    this.raycaster.setFromCamera(ndc(this.host, e), this.camera);
  }

  private capture(mode: Mode, e: PointerEvent) {
    this.mode = mode;
    this.host.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  private readonly onDown = (e: PointerEvent) => {
    this.host.focus();
    this.down = this.last = { x: e.clientX, y: e.clientY };
    if (e.button === MIDDLE || e.button === RIGHT || (e.button === 0 && e.altKey)) return this.capture(e.shiftKey ? "pan" : "orbit", e);
    if (e.button !== 0) return;
    const { onPaint, parts, selected } = this.props.current;
    if (onPaint) {
      this.capture("paint", e);
      this.aim(e);
      return onPaint(paintHit(this.three, this.raycaster), "down", e.altKey);
    }
    this.aim(e);
    const hit = this.raycaster.intersectObjects(this.three.handles, false)[0];
    const editable = parts.find((p) => p.editable);
    if (!hit || selected === null || !editable) return;
    const handle = hit.object.userData.handle as Handle;
    this.handleDrag = startHandleDrag({ object: hit.object, handle }, editable.elements[selected], editable, { camera: this.camera, rect: this.host.getBoundingClientRect() }, { x: e.clientX, y: e.clientY });
    if (this.handleDrag) this.capture("handle", e);
  };

  private readonly onMove = (e: PointerEvent) => {
    if (!this.mode) return;
    const dx = e.clientX - this.last.x;
    const dy = e.clientY - this.last.y;
    this.last = { x: e.clientX, y: e.clientY };
    const cam = this.three.cam;
    if (this.mode === "paint") {
      this.aim(e);
      const hit = paintHit(this.three, this.raycaster);
      if (hit) this.props.current.onPaint?.(hit, "move", e.altKey);
    } else if (this.mode === "orbit") {
      cam.theta -= dx * ORBIT_SPEED;
      cam.phi = clampPhi(cam.phi - dy * ORBIT_SPEED);
      this.invalidate();
    } else if (this.mode === "pan") {
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      const k = cam.dist * PAN_SPEED;
      cam.target.add(right.multiplyScalar(-dx * k)).add(up.multiplyScalar(dy * k));
      this.invalidate();
    } else if (this.mode === "handle" && this.handleDrag && this.props.current.selected !== null) {
      this.live = draggedBounds(this.handleDrag, e.clientX, e.clientY, e.shiftKey, e.ctrlKey);
      this.setDrag({ index: this.props.current.selected, ...this.live });
    }
  };

  private readonly onUp = (e: PointerEvent) => {
    const { selected, onTransform, onPaint, onSelect } = this.props.current;
    if (this.mode === "handle" && this.live && selected !== null) onTransform?.(selected, this.live.from, this.live.to);
    if (this.mode === "paint") {
      this.aim(e);
      onPaint?.(paintHit(this.three, this.raycaster), "up", e.altKey);
    }
    if (this.mode) {
      this.mode = null;
      this.handleDrag = null;
      this.live = null;
      this.setDrag(null);
      this.host.releasePointerCapture?.(e.pointerId);
      return;
    }
    const wasClick = Math.abs(e.clientX - this.down.x) + Math.abs(e.clientY - this.down.y) < CLICK_SLOP;
    if (e.button !== 0 || !wasClick) return;
    this.aim(e);
    const hit = this.raycaster.intersectObjects(this.three.model.children, true).find((h) => {
      const data = h.object.userData as MeshData;
      return data.part === PART.edit && data.element !== undefined;
    });
    const data = hit?.object.userData as MeshData | undefined;
    if (data?.element !== undefined) onSelect(data.element, data.face as Dir);
    else onSelect(null, null);
  };

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const cam = this.three.cam;
    cam.dist = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, cam.dist * Math.exp(e.deltaY * ZOOM_SPEED)));
    this.invalidate();
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (!viewKey(e, this.three, this.toggleOrtho)) return;
    this.invalidate();
    e.preventDefault();
    e.stopPropagation();
  };
}
