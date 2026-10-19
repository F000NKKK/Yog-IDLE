// The model in the scene: each part's elements (or sprite layers) as face
// meshes, the selected element's outline and face highlight, and its
// move/resize handles.

import * as THREE from "three";
import { autoUv, DIRS, type Dir, FACE_SHADE, faceCorners, type Element, type Vec3 } from "../model";
import { type AnimatedTexture, ACCENT, displayMatrix, displayReference, elementMatrix, faceMesh, faceUvs, loadTexture, material, spriteGeometry, stateMatrix, boxEdges } from "./scene";
import { addHandles } from "./handles";
import type { ThreeView } from "./threeView";
import type { GizmoMode, Part, TextureSource, ViewportProps } from "./viewportTypes";

/** What a mesh is: on the edited part or another, which element and face, which texture slot it paints. */
export interface MeshData {
  part?: typeof PART.edit | typeof PART.other;
  element?: number;
  face?: Dir;
  paint?: { slot: string };
}

export const PART = { edit: "edit", other: "other" } as const;
/** A sprite's layers are stacked this far apart, so they don't z-fight. */
const SPRITE_LAYER_GAP = 0.01;
/** The selected face's highlight. */
const HIGHLIGHT_OPACITY = 0.35;
const HIGHLIGHT_ORDER = 11;
const NO_UV: [number, number][] = [[0, 0], [0, 0], [0, 0], [0, 0]];

/** What the model is built from — the view's props, the element being dragged, and a callback when a texture finishes loading. */
export interface ModelInput extends Pick<ViewportProps, "parts" | "images" | "selected" | "selectedFace" | "shading" | "renderLayer" | "display" | "onTransform"> {
  gizmo: GizmoMode;
  drag: { index: number; from: Vec3; to: Vec3 } | null;
  onLoad: () => void;
}

/** What every part of the build shares: the view, its input, and what to dispose when it's rebuilt. */
interface Build {
  three: ThreeView;
  input: ModelInput;
  disposables: { dispose(): void }[];
}

/** Builds the model into `three` — returns what to dispose when it's rebuilt. */
export function buildModel(three: ThreeView, input: ModelInput): { dispose(): void }[] {
  const { parts, display, selected, onTransform, drag, gizmo } = input;
  const build: Build = { three, input, disposables: [] };
  three.model.clear();
  three.overlay.clear();
  three.handles = [];
  const root = new THREE.Group();
  if (display) {
    root.matrixAutoUpdate = false;
    root.matrix.copy(displayMatrix(display.transform));
    three.overlay.add(displayReference(display.slot));
  }
  three.model.add(root);
  three.animated = [];
  let outlined = false;
  for (const part of parts) {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.matrix.copy(stateMatrix(part.x, part.y));
    root.add(group);
    if (part.sprite) addSprite(build, part, group);
    else outlined = addElements(build, part, group) || outlined;
  }
  // Handles of the selected element (in the model's frame, unrotated).
  const editable = parts.find((p) => p.editable);
  const sel = selected !== null ? editable?.elements[selected] : undefined;
  if (editable && sel && outlined && onTransform && !display) {
    const el = drag && drag.index === selected ? { ...sel, from: drag.from, to: drag.to } : sel;
    addHandles(three, el, editable, gizmo);
  }
  return build.disposables;
}

/** The texture for a slot's value: loaded (animated ones registered to advance), or the checkerboard. */
function textureOf(three: ThreeView, input: ModelInput, value: string | undefined): THREE.Texture {
  const src = value ? input.images[value] : undefined;
  if (!src) return three.checker;
  const { texture } = loadTexture(src, input.onLoad);
  if (src.animation) three.animated.push({ texture, src });
  return texture;
}

/** An item sprite: each layer's opaque pixels extruded 1px, shaped per animation frame. */
function addSprite({ three, input, disposables }: Build, part: Part, group: THREE.Group) {
  for (const [layer, { slot, texture: value }] of (part.sprite ?? []).entries()) {
    const src = input.images[value];
    if (!src) continue;
    const entry = loadTexture(src, input.onLoad);
    const img = entry.texture.image as HTMLImageElement | undefined;
    if (!img || !img.width) continue;
    const shapeOf = spriteShapes(img, src, input.shading, disposables);
    const mat = material(entry.texture, "cutout", !!part.ghost);
    mat.vertexColors = true;
    if (part.tints?.[layer]) mat.color.set(part.tints[layer]);
    const mesh = new THREE.Mesh(shapeOf(src.pinned ?? src.animation?.frames[0]?.index ?? 0), mat);
    if (src.animation) three.animated.push({ texture: entry.texture, src, shapeOf: (frame) => (mesh.geometry = shapeOf(frame)) } satisfies AnimatedTexture);
    mesh.userData = { part: part.editable ? PART.edit : PART.other, paint: { slot } } satisfies MeshData;
    mesh.position.z = layer * SPRITE_LAYER_GAP;
    group.add(mesh);
    disposables.push(mat);
  }
}

/** A sprite's shape is its frame's opaque pixels: an animated one has a shape per frame, made when first shown (see `draw`). */
function spriteShapes(img: HTMLImageElement, src: TextureSource, shading: boolean, disposables: { dispose(): void }[]) {
  const shapes = new Map<number, THREE.BufferGeometry>();
  return (frame: number) => {
    let geo = shapes.get(frame);
    if (!geo) {
      geo = spriteGeometry(img, src.animation, frame);
      if (!shading) geo.setAttribute("color", new THREE.Float32BufferAttribute(new Array(geo.getAttribute("position").count * 3).fill(1), 3));
      shapes.set(frame, geo);
      disposables.push(geo);
    }
    return geo;
  };
}

/** A part's elements as face meshes; `true` if the selected one was outlined. */
function addElements(build: Build, part: Part, group: THREE.Group): boolean {
  const { drag, selected } = build.input;
  let outlined = false;
  for (const [index, base] of part.elements.entries()) {
    const el = part.editable && drag && drag.index === index ? { ...base, from: drag.from, to: drag.to } : base;
    const eg = new THREE.Group();
    eg.matrixAutoUpdate = false;
    eg.matrix.copy(elementMatrix(el));
    group.add(eg);
    for (const dir of DIRS) addFace(build, { part, el, index, dir }, eg);
    if (part.editable && index === selected) {
      eg.add(boxEdges(el.from, el.to, ACCENT));
      outlined = true;
    }
  }
  return outlined;
}

/** One face of element `index` of `part`. */
function addFace({ three, input, disposables }: Build, { part, el, index, dir }: { part: Part; el: Element; index: number; dir: Dir }, eg: THREE.Group) {
  const face = el.faces[dir];
  if (!face) return;
  const slot = face.texture.replace(/^#/, "");
  const mat = material(textureOf(three, input, part.textures[slot]), input.renderLayer, !!part.ghost);
  if (face.tint !== undefined && part.tints?.[face.tint]) mat.color.set(part.tints[face.tint]);
  const shade = input.shading && el.shade !== false ? FACE_SHADE[dir] : 1;
  const uv = face.uv ?? autoUv(dir, el.from, el.to);
  const mesh = faceMesh(faceCorners(dir, el.from, el.to), faceUvs(uv, face.rotation ?? 0), shade, mat);
  mesh.userData = { part: part.editable ? PART.edit : PART.other, element: index, face: dir, paint: { slot } } satisfies MeshData;
  eg.add(mesh);
  disposables.push(mesh.geometry, mat);
  if (part.editable && index === input.selected && dir === input.selectedFace) {
    const highlight = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: HIGHLIGHT_OPACITY, depthTest: false, side: THREE.DoubleSide });
    const hl = faceMesh(faceCorners(dir, el.from, el.to), NO_UV, 1, highlight);
    hl.renderOrder = HIGHLIGHT_ORDER;
    eg.add(hl);
    disposables.push(hl.geometry);
  }
}
