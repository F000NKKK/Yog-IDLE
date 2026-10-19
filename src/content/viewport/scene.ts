// The model view's three.js pieces: textures (animated, cached), element and
// state matrices, face meshes, sprites, outlines, labels, display references.

import * as THREE from "three";
import { frameRect, type TextureAnimation } from "../animation";
import type { DisplayTransform, Element, Vec3 } from "../model";
import type { TextureSource, ViewName } from "./viewportTypes";

export const CENTER = new THREE.Vector3(8, 8, 8);
export const ACCENT = 0x3b8eea;
export const AXIS_COLORS = { x: 0xe5484d, y: 0x46a758, z: 0x3e63dd };

export function checkerTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 2;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f800f8";
  g.fillRect(0, 0, 2, 2);
  g.fillStyle = "#000";
  g.fillRect(0, 0, 1, 1);
  g.fillRect(1, 1, 1, 1);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(8, 8);
  return t;
}

/** An animated texture in the scene, and for a sprite, how to give its mesh the shape of a frame. */
export interface AnimatedTexture {
  texture: THREE.Texture;
  src: TextureSource;
  shapeOf?: (frame: number) => void;
}

/** Loaded textures (shared, keyed by URL) and their pixels for sprites. */
export const textureCache = new Map<string, { texture: THREE.Texture; image: Promise<HTMLImageElement> }>();

/**
 * Shows image frame `index` of `anim` on `texture`: geometry maps one frame
 * to the whole 0–1 UV square, the texture's repeat/offset pick the frame.
 */
export function showFrame(texture: THREE.Texture, anim: TextureAnimation | null, index: number) {
  const img = texture.image as HTMLImageElement | undefined;
  if (!img?.width) return;
  if (!anim) {
    texture.repeat.set(1, 1);
    texture.offset.set(0, 0);
    return;
  }
  const [x, y, w, h] = frameRect(anim, img.width, index);
  texture.repeat.set(w / img.width, h / img.height);
  texture.offset.set(x / img.width, 1 - (y + h) / img.height);
}

export function loadTexture(src: TextureSource, onLoad: () => void): { texture: THREE.Texture; image: Promise<HTMLImageElement> } {
  const hit = textureCache.get(src.url);
  if (hit) {
    if (!hit.texture.image) void hit.image.then(onLoad);
    return hit;
  }
  const texture = new THREE.Texture();
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  const image = new Promise<HTMLImageElement>((resolve) => {
    const img = new Image();
    img.onload = () => {
      texture.image = img;
      showFrame(texture, src.animation, src.pinned ?? src.animation?.frames[0]?.index ?? 0);
      texture.needsUpdate = true;
      resolve(img);
      onLoad();
    };
    img.src = src.url;
  });
  const entry = { texture, image };
  textureCache.set(src.url, entry);
  if (textureCache.size > 400) {
    const oldest = textureCache.keys().next().value!;
    textureCache.get(oldest)?.texture.dispose();
    textureCache.delete(oldest);
  }
  return entry;
}

/** The face's 4 UV corners (TL, TR, BR, BL) after its rotation, in 0..1 with v up. */
export function faceUvs(uv: [number, number, number, number], rotation: number): [number, number][] {
  const [u1, v1, u2, v2] = uv;
  const corners: [number, number][] = [
    [u1, v1],
    [u2, v1],
    [u2, v2],
    [u1, v2],
  ];
  const k = (((Math.round(rotation / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  return [0, 1, 2, 3].map((i) => {
    const [u, v] = corners[(i - k + 4) % 4];
    return [u / 16, 1 - v / 16] as [number, number];
  });
}

/** The matrix of an element's rotation (around its origin, with rescale). */
export function elementMatrix(el: Element): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  const r = el.rotation;
  if (!r || !r.angle) return m;
  const o = new THREE.Vector3(...(r.origin ?? [8, 8, 8]));
  const rad = THREE.MathUtils.degToRad(r.angle);
  const rot = new THREE.Matrix4();
  const scale = new THREE.Vector3(1, 1, 1);
  const s = r.rescale ? 1 / Math.cos(Math.abs(rad)) : 1;
  if (r.axis === "x") {
    rot.makeRotationX(rad);
    scale.set(1, s, s);
  } else if (r.axis === "y") {
    rot.makeRotationY(rad);
    scale.set(s, 1, s);
  } else {
    rot.makeRotationZ(rad);
    scale.set(s, s, 1);
  }
  m.makeTranslation(o.x, o.y, o.z)
    .multiply(rot)
    .multiply(new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z))
    .multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z));
  return m;
}

/** A blockstate x/y rotation around the block's center. */
export function stateMatrix(x = 0, y = 0): THREE.Matrix4 {
  // Minecraft rotates X first, then Y, both clockwise looking down the axis.
  const rx = new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(-x));
  const ry = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(-y));
  return new THREE.Matrix4()
    .makeTranslation(8, 8, 8)
    .multiply(ry)
    .multiply(rx)
    .multiply(new THREE.Matrix4().makeTranslation(-8, -8, -8));
}

export function material(map: THREE.Texture, layer: string | undefined, ghost: boolean): THREE.MeshBasicMaterial {
  const translucent = layer === "translucent" || ghost;
  return new THREE.MeshBasicMaterial({
    map,
    vertexColors: true,
    transparent: translucent,
    opacity: ghost ? 0.45 : 1,
    alphaTest: translucent ? 0 : 0.1,
    depthWrite: !translucent,
    side: THREE.FrontSide,
  });
}

/** The quad of one face as a mesh. */
export function faceMesh(corners: Vec3[], uvs: [number, number][], shade: number, mat: THREE.Material): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  const pos = corners.flat();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs.flat(), 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute([shade, shade, shade, shade, shade, shade, shade, shade, shade, shade, shade, shade], 3));
  g.setIndex([0, 3, 2, 0, 2, 1]);
  g.computeBoundingSphere();
  return new THREE.Mesh(g, mat);
}

/** Pixels of a sprite → its extruded geometry (front, back and the edges of opaque pixels). */
export function spriteGeometry(img: HTMLImageElement, anim: TextureAnimation | null, frame: number): THREE.BufferGeometry {
  // The shape is the shown frame's opaque pixels; its UVs span one frame (see `showFrame`).
  const [fx, fy, w, h] = anim ? frameRect(anim, img.width, frame) : [0, 0, img.width, img.height];
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, -fx, -fy);
  const data = g.getImageData(0, 0, w, h).data;
  const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] > 25;
  const px = 16 / w;
  const py = 16 / h;
  const z0 = 7.5;
  const z1 = 8.5;
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const quad = (p: number[][], t: number[][], shade: number) => {
    for (const i of [0, 3, 2, 0, 2, 1]) {
      pos.push(...p[i]);
      uv.push(...t[i]);
      col.push(shade, shade, shade);
    }
  };
  const U = (x: number) => x / w;
  const V = (y: number) => 1 - y / h;
  // Front (south, +z) and back.
  quad([[0, 16, z1], [16, 16, z1], [16, 0, z1], [0, 0, z1]], [[0, 1], [1, 1], [1, 0], [0, 0]], 1);
  quad([[16, 16, z0], [0, 16, z0], [0, 0, z0], [16, 0, z0]], [[1, 1], [0, 1], [0, 0], [1, 0]], 0.8);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!opaque(x, y)) continue;
      const x0 = x * px;
      const x1 = (x + 1) * px;
      const yTop = 16 - y * py;
      const yBot = 16 - (y + 1) * py;
      const t = [
        [U(x + 0.25), V(y + 0.25)],
        [U(x + 0.75), V(y + 0.25)],
        [U(x + 0.75), V(y + 0.75)],
        [U(x + 0.25), V(y + 0.75)],
      ];
      if (!opaque(x, y - 1)) quad([[x0, yTop, z0], [x1, yTop, z0], [x1, yTop, z1], [x0, yTop, z1]], t, 1);
      if (!opaque(x, y + 1)) quad([[x0, yBot, z1], [x1, yBot, z1], [x1, yBot, z0], [x0, yBot, z0]], t, 0.5);
      if (!opaque(x - 1, y)) quad([[x0, yTop, z0], [x0, yTop, z1], [x0, yBot, z1], [x0, yBot, z0]], t, 0.6);
      if (!opaque(x + 1, y)) quad([[x1, yTop, z1], [x1, yTop, z0], [x1, yBot, z0], [x1, yBot, z1]], t, 0.6);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

/** Edges of an element's box, for the selection outline. */
export function boxEdges(from: Vec3, to: Vec3, color: number): THREE.LineSegments {
  const box = new THREE.BoxGeometry(Math.max(to[0] - from[0], 0.01), Math.max(to[1] - from[1], 0.01), Math.max(to[2] - from[2], 0.01));
  const lines = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
  lines.position.set((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2);
  lines.renderOrder = 10;
  return lines;
}

/** On-screen diameter of the viewport's "N" compass label, in CSS px (the axes gizmo's labels are ~12px). */
export const NORTH_MARKER_PX = 20;

/** A text label sprite (axes gizmo). */
export function label(text: string, color: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = color;
  g.beginPath();
  g.arc(32, 32, 28, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#fff";
  g.font = "bold 36px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 32, 34);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  s.scale.set(0.5, 0.5, 0.5);
  return s;
}

/** Reference objects for a display preview (approximate). */
export function displayReference(slot: string): THREE.Object3D {
  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: 0x8a8a8a });
  const square = (size: number, z: number) => {
    const g = new THREE.EdgesGeometry(new THREE.PlaneGeometry(size, size));
    const l = new THREE.LineSegments(g, mat);
    l.position.set(8, 8, z);
    return l;
  };
  if (slot === "gui") group.add(square(16, -8));
  else if (slot === "fixed") group.add(square(16, 0.5));
  else if (slot === "head") group.add(boxEdges([4, 0, 4], [12, 8, 12], 0x8a8a8a));
  else if (slot === "ground") {
    const grid = new THREE.GridHelper(32, 32, 0x707070, 0x505050);
    grid.position.set(8, 0, 8);
    group.add(grid);
  } else if (slot.includes("hand")) group.add(boxEdges([6, -12, 6], [10, 0, 10], 0x8a8a8a));
  return group;
}

/** Minecraft applies display transforms around the model's center: translate, rotate (XYZ), scale. */
export function displayMatrix(t: DisplayTransform): THREE.Matrix4 {
  const [tx, ty, tz] = t.translation ?? [0, 0, 0];
  const [rx, ry, rz] = t.rotation ?? [0, 0, 0];
  const [sx, sy, sz] = t.scale ?? [1, 1, 1];
  const rot = new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(THREE.MathUtils.degToRad(rx), THREE.MathUtils.degToRad(ry), THREE.MathUtils.degToRad(rz), "XYZ")
  );
  return new THREE.Matrix4()
    .makeTranslation(8 + tx, 8 + ty, 8 + tz)
    .multiply(rot)
    .multiply(new THREE.Matrix4().makeScale(sx, sy, sz))
    .multiply(new THREE.Matrix4().makeTranslation(-8, -8, -8));
}

export interface Handle {
  kind: "move" | "resize";
  axis: 0 | 1 | 2;
  /** Resize: which side (+1 = `to`, -1 = `from`). */
  side: 1 | -1;
}

export const VIEWS: Record<ViewName, { theta: number; phi: number }> = {
  // theta: angle around Y from +Z; phi: from +Y. Front = looking at the north face.
  front: { theta: Math.PI, phi: Math.PI / 2 },
  back: { theta: 0, phi: Math.PI / 2 },
  right: { theta: -Math.PI / 2, phi: Math.PI / 2 },
  left: { theta: Math.PI / 2, phi: Math.PI / 2 },
  top: { theta: Math.PI, phi: 0.0001 },
  bottom: { theta: Math.PI, phi: Math.PI - 0.0001 },
};
