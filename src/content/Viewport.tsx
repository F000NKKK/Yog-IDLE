import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import * as THREE from "three";
import {
  autoUv,
  DIRS,
  DIR_NORMAL,
  FACE_SHADE,
  faceCorners,
  type Dir,
  type DisplayTransform,
  type Element,
  type Vec3,
} from "./model";

// The model editor's 3D view: Minecraft model elements drawn with nearest
// filtering and Minecraft's per-face shading, an orbit camera that handles
// like Blender's (middle drag orbits, Shift+middle pans, wheel zooms, numpad
// 1/3/7 front/side/top, 5 perspective/orthographic), a grid with the block's
// bounds, an axes gizmo, click-to-select, and move/resize handles that snap
// to Minecraft's pixel grid. One unit = one model pixel.

/** A texture the view can draw: a data URL; `animated` = frames stacked vertically. */
export interface TextureSource {
  url: string;
  animated: boolean;
}

/** One model drawn in the view. */
export interface Part {
  elements: Element[];
  /** Slot → texture value, `#refs` resolved. */
  textures: Record<string, string>;
  /** Blockstate rotation (degrees, multiples of 90). */
  x?: number;
  y?: number;
  /** An item sprite: these textures (layer0, layer1, ...) extruded 1px thick. */
  sprite?: string[];
  /** Selectable and editable (the model being edited). */
  editable?: boolean;
  /** Drawn translucent (the arms of a connecting block, say). */
  ghost?: boolean;
}

export type GizmoMode = "move" | "resize";
export type ViewName = "front" | "back" | "right" | "left" | "top" | "bottom";

export interface ViewportProps {
  parts: Part[];
  /** Texture value → its image (missing ones draw a checkerboard). */
  images: Record<string, TextureSource | undefined>;
  selected: number | null;
  selectedFace: Dir | null;
  onSelect: (element: number | null, face: Dir | null) => void;
  /** A finished move/resize of the editable part's element. */
  onTransform?: (element: number, from: Vec3, to: Vec3) => void;
  gizmo: GizmoMode;
  shading: boolean;
  showGrid: boolean;
  /** Cutout/translucent: how alpha is drawn. */
  renderLayer?: string;
  /** Preview a display transform (with a reference object for its slot). */
  display?: { slot: string; transform: DisplayTransform } | null;
  /** Bumped to jump to a view. */
  viewRequest?: { view: ViewName; key: number } | null;
  style?: CSSProperties;
  className?: string;
}

const CENTER = new THREE.Vector3(8, 8, 8);
const ACCENT = 0x3b8eea;
const AXIS_COLORS = { x: 0xe5484d, y: 0x46a758, z: 0x3e63dd };

function checkerTexture(): THREE.Texture {
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

/** Loaded textures (shared, keyed by URL) and their pixels for sprites. */
const textureCache = new Map<string, { texture: THREE.Texture; image: Promise<HTMLImageElement> }>();

function loadTexture(src: TextureSource, onLoad: () => void): { texture: THREE.Texture; image: Promise<HTMLImageElement> } {
  const hit = textureCache.get(src.url);
  if (hit) return hit;
  const texture = new THREE.Texture();
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  const image = new Promise<HTMLImageElement>((resolve) => {
    const img = new Image();
    img.onload = () => {
      texture.image = img;
      // An animated texture: show its first frame.
      if (src.animated && img.height > img.width) {
        const frames = img.height / img.width;
        texture.repeat.set(1, 1 / frames);
        texture.offset.set(0, 1 - 1 / frames);
      }
      texture.needsUpdate = true;
      resolve(img);
      onLoad();
    };
    img.src = src.url;
  });
  const entry = { texture, image };
  textureCache.set(src.url, entry);
  if (textureCache.size > 400) textureCache.delete(textureCache.keys().next().value!);
  return entry;
}

/** The face's 4 UV corners (TL, TR, BR, BL) after its rotation, in 0..1 with v up. */
function faceUvs(uv: [number, number, number, number], rotation: number): [number, number][] {
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
function elementMatrix(el: Element): THREE.Matrix4 {
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
function stateMatrix(x = 0, y = 0): THREE.Matrix4 {
  // Minecraft rotates X first, then Y, both clockwise looking down the axis.
  const rx = new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(-x));
  const ry = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(-y));
  return new THREE.Matrix4()
    .makeTranslation(8, 8, 8)
    .multiply(ry)
    .multiply(rx)
    .multiply(new THREE.Matrix4().makeTranslation(-8, -8, -8));
}

function material(map: THREE.Texture, layer: string | undefined, ghost: boolean): THREE.MeshBasicMaterial {
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
function faceMesh(corners: Vec3[], uvs: [number, number][], shade: number, mat: THREE.Material): THREE.Mesh {
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
function spriteGeometry(img: HTMLImageElement, animated: boolean): THREE.BufferGeometry {
  const w = img.width;
  const h = animated && img.height > img.width ? img.width : img.height;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
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
  const vFrame = animated && img.height > img.width ? img.width / img.height : 1;
  const U = (x: number) => x / w;
  const V = (y: number) => 1 - (y / h) * vFrame;
  // Front (south, +z) and back.
  quad([[0, 16, z1], [16, 16, z1], [16, 0, z1], [0, 0, z1]], [[0, 1], [1, 1], [1, 1 - vFrame], [0, 1 - vFrame]], 1);
  quad([[16, 16, z0], [0, 16, z0], [0, 0, z0], [16, 0, z0]], [[1, 1], [0, 1], [0, 1 - vFrame], [1, 1 - vFrame]], 0.8);
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
function boxEdges(from: Vec3, to: Vec3, color: number): THREE.LineSegments {
  const box = new THREE.BoxGeometry(Math.max(to[0] - from[0], 0.01), Math.max(to[1] - from[1], 0.01), Math.max(to[2] - from[2], 0.01));
  const lines = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
  lines.position.set((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2);
  lines.renderOrder = 10;
  return lines;
}

/** On-screen diameter of the viewport's "N" compass label, in CSS px (the axes gizmo's labels are ~12px). */
const NORTH_MARKER_PX = 20;

/** A text label sprite (axes gizmo). */
function label(text: string, color: string): THREE.Sprite {
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
function displayReference(slot: string): THREE.Object3D {
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
function displayMatrix(t: DisplayTransform): THREE.Matrix4 {
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

interface Handle {
  kind: "move" | "resize";
  axis: 0 | 1 | 2;
  /** Resize: which side (+1 = `to`, -1 = `from`). */
  side: 1 | -1;
}

const VIEWS: Record<ViewName, { theta: number; phi: number }> = {
  // theta: angle around Y from +Z; phi: from +Y. Front = looking at the north face.
  front: { theta: Math.PI, phi: Math.PI / 2 },
  back: { theta: 0, phi: Math.PI / 2 },
  right: { theta: -Math.PI / 2, phi: Math.PI / 2 },
  left: { theta: Math.PI / 2, phi: Math.PI / 2 },
  top: { theta: Math.PI, phi: 0.0001 },
  bottom: { theta: Math.PI, phi: Math.PI - 0.0001 },
};

export function Viewport({
  parts,
  images,
  selected,
  selectedFace,
  onSelect,
  onTransform,
  gizmo,
  shading,
  showGrid,
  renderLayer,
  display,
  viewRequest,
  style,
  className,
}: ViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [ortho, setOrtho] = useState(false);
  const [loaded, setLoaded] = useState(0);
  /** An element being dragged: its live from/to. */
  const [drag, setDrag] = useState<{ index: number; from: Vec3; to: Vec3 } | null>(null);

  // ── Three.js objects that live as long as the view ────────────────────────

  const three = useMemo(() => {
    const scene = new THREE.Scene();
    const persp = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
    const orth = new THREE.OrthographicCamera(-20, 20, 20, -20, -1000, 1000);
    const model = new THREE.Group();
    const overlay = new THREE.Group();
    const grid = new THREE.Group();
    scene.add(grid, model, overlay);
    const g1 = new THREE.GridHelper(16, 16, 0x5a5a5a, 0x3a3a3a);
    g1.position.set(8, 0, 8);
    const g2 = new THREE.GridHelper(48, 3, 0x4a4a4a, 0x4a4a4a);
    g2.position.set(8, 0, 8);
    grid.add(g1, g2, boxEdges([0, 0, 0], [16, 16, 16], 0x505050));
    // North marker under the grid's north edge — a compass label, kept at a
    // fixed on-screen size each frame (see NORTH_MARKER_PX) rather than
    // scaling with the model.
    const north = label("N", "#555");
    north.position.set(8, 0, -1.5);
    grid.add(north);
    const axesScene = new THREE.Scene();
    const axesCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, -10, 10);
    for (const [i, name] of (["x", "y", "z"] as const).entries()) {
      const dir = new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
      const color = AXIS_COLORS[name];
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir]), new THREE.LineBasicMaterial({ color }));
      axesScene.add(line);
      const l = label(name.toUpperCase(), `#${color.toString(16).padStart(6, "0")}`);
      l.position.copy(dir.clone().multiplyScalar(1.2));
      axesScene.add(l);
    }
    return {
      scene,
      persp,
      orth,
      model,
      overlay,
      grid,
      axesScene,
      axesCam,
      north,
      checker: checkerTexture(),
      cam: { theta: Math.PI * 0.75, phi: Math.PI / 3, dist: 40, target: CENTER.clone() },
      handles: [] as THREE.Object3D[],
      renderer: null as THREE.WebGLRenderer | null,
      frame: 0,
    };
  }, []);

  const invalidate = useRef(() => {});

  // ── Renderer, camera, loop-on-demand ──────────────────────────────────────

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x262626);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.autoClear = false;
    host.appendChild(renderer.domElement);
    three.renderer = renderer;
    const draw = () => {
      three.frame = 0;
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
      const { theta, phi, dist, target } = three.cam;
      const offset = new THREE.Vector3(Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta)).multiplyScalar(dist);
      const camera = ortho ? three.orth : three.persp;
      if (ortho) {
        const half = dist * 0.42;
        three.orth.left = (-half * w) / h;
        three.orth.right = (half * w) / h;
        three.orth.top = half;
        three.orth.bottom = -half;
      } else three.persp.aspect = w / h;
      camera.position.copy(target).add(offset);
      camera.up.set(0, 1, 0);
      camera.lookAt(target);
      camera.updateProjectionMatrix();
      const unitsPerPx = ortho
        ? (three.orth.top - three.orth.bottom) / h
        : (2 * camera.position.distanceTo(three.north.getWorldPosition(new THREE.Vector3())) * Math.tan(THREE.MathUtils.degToRad(three.persp.fov / 2))) / h;
      three.north.scale.setScalar(NORTH_MARKER_PX * unitsPerPx);
      renderer.setViewport(0, 0, w, h);
      renderer.setScissorTest(false);
      renderer.clear();
      renderer.render(three.scene, camera);
      // Axes gizmo, bottom-left.
      const size = 80;
      three.axesCam.position.copy(offset.clone().normalize().multiplyScalar(5));
      three.axesCam.lookAt(0, 0, 0);
      renderer.setViewport(4, 4, size, size);
      renderer.setScissor(4, 4, size, size);
      renderer.setScissorTest(true);
      renderer.clearDepth();
      renderer.render(three.axesScene, three.axesCam);
      renderer.setScissorTest(false);
    };
    invalidate.current = () => {
      if (!three.frame) three.frame = requestAnimationFrame(draw);
    };
    const ro = new ResizeObserver(() => invalidate.current());
    ro.observe(host);
    invalidate.current();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(three.frame);
      three.frame = 0;
      renderer.dispose();
      renderer.domElement.remove();
      three.renderer = null;
    };
  }, [three, ortho]);

  // ── Jump to a view ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!viewRequest) return;
    const v = VIEWS[viewRequest.view];
    three.cam.theta = v.theta;
    three.cam.phi = v.phi;
    three.cam.target.copy(CENTER);
    setOrtho(true);
    invalidate.current();
  }, [viewRequest, three]);

  // ── The model ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const disposables: { dispose(): void }[] = [];
    three.model.clear();
    three.overlay.clear();
    three.handles = [];
    three.grid.visible = showGrid;
    const root = new THREE.Group();
    if (display) {
      root.matrixAutoUpdate = false;
      root.matrix.copy(displayMatrix(display.transform));
      three.overlay.add(displayReference(display.slot));
    }
    three.model.add(root);
    let outline: THREE.Object3D | null = null;
    let outlineMatrix = new THREE.Matrix4();
    for (const part of parts) {
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      group.matrix.copy(stateMatrix(part.x, part.y));
      root.add(group);
      const textureOf = (value: string | undefined): THREE.Texture => {
        const src = value ? images[value] : undefined;
        return src ? loadTexture(src, () => setLoaded((n) => n + 1)).texture : three.checker;
      };
      if (part.sprite) {
        for (const [layer, value] of part.sprite.entries()) {
          const src = images[value];
          if (!src) continue;
          const entry = loadTexture(src, () => setLoaded((n) => n + 1));
          const img = entry.texture.image as HTMLImageElement | undefined;
          if (!img || !img.width) continue;
          const geo = spriteGeometry(img, src.animated);
          const mat = material(entry.texture, "cutout", !!part.ghost);
          mat.vertexColors = true;
          if (!shading) geo.setAttribute("color", new THREE.Float32BufferAttribute(new Array(geo.getAttribute("position").count * 3).fill(1), 3));
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.z = layer * 0.01;
          group.add(mesh);
          disposables.push(geo, mat);
        }
        continue;
      }
      for (const [index, base] of part.elements.entries()) {
        const el = part.editable && drag && drag.index === index ? { ...base, from: drag.from, to: drag.to } : base;
        const eg = new THREE.Group();
        eg.matrixAutoUpdate = false;
        eg.matrix.copy(elementMatrix(el));
        group.add(eg);
        for (const dir of DIRS) {
          const face = el.faces[dir];
          if (!face) continue;
          const slot = face.texture.replace(/^#/, "");
          const map = textureOf(part.textures[slot]);
          const mat = material(map, renderLayer, !!part.ghost);
          const shade = shading && el.shade !== false ? FACE_SHADE[dir] : 1;
          const uv = face.uv ?? autoUv(dir, el.from, el.to);
          const mesh = faceMesh(faceCorners(dir, el.from, el.to), faceUvs(uv, face.rotation ?? 0), shade, mat);
          mesh.userData = { part: part.editable ? "edit" : "other", element: index, face: dir };
          eg.add(mesh);
          disposables.push(mesh.geometry, mat);
          if (part.editable && index === selected && dir === selectedFace) {
            const hl = faceMesh(
              faceCorners(dir, el.from, el.to),
              [[0, 0], [0, 0], [0, 0], [0, 0]],
              1,
              new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.35, depthTest: false, side: THREE.DoubleSide })
            );
            hl.renderOrder = 11;
            eg.add(hl);
            disposables.push(hl.geometry);
          }
        }
        if (part.editable && index === selected) {
          outline = boxEdges(el.from, el.to, ACCENT);
          eg.add(outline);
          outlineMatrix = new THREE.Matrix4().multiplyMatrices(group.matrix, eg.matrix);
        }
      }
    }
    // Handles of the selected element (in the model's frame, unrotated).
    const sel = selected !== null ? parts.find((p) => p.editable)?.elements[selected] : undefined;
    if (sel && outline && onTransform && !display) {
      const el = drag && drag.index === selected ? { ...sel, from: drag.from, to: drag.to } : sel;
      const handles = new THREE.Group();
      handles.matrixAutoUpdate = false;
      handles.matrix.copy(stateMatrix(parts.find((p) => p.editable)?.x, parts.find((p) => p.editable)?.y));
      const center = new THREE.Vector3((el.from[0] + el.to[0]) / 2, (el.from[1] + el.to[1]) / 2, (el.from[2] + el.to[2]) / 2);
      for (const axis of [0, 1, 2] as const) {
        const name = (["x", "y", "z"] as const)[axis];
        const color = AXIS_COLORS[name];
        const dir = new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
        const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
        if (gizmo === "move") {
          const len = 6 + Math.max(...el.to.map((t, i) => t - el.from[i])) / 2;
          const arrow = new THREE.ArrowHelper(dir, center, len, color, 1.6, 1);
          (arrow.line.material as THREE.LineBasicMaterial).depthTest = false;
          (arrow.cone.material as THREE.MeshBasicMaterial).depthTest = false;
          arrow.renderOrder = 20;
          arrow.traverse((o) => (o.renderOrder = 20));
          // A fat invisible pick target along the arrow.
          const pick = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, len, 6), new THREE.MeshBasicMaterial({ visible: false }));
          pick.position.copy(center.clone().add(dir.clone().multiplyScalar(len / 2)));
          pick.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
          pick.userData = { handle: { kind: "move", axis, side: 1 } satisfies Handle };
          handles.add(arrow, pick);
          three.handles.push(pick);
        } else {
          for (const side of [1, -1] as const) {
            const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
            const p = center.clone();
            p.setComponent(axis, side === 1 ? el.to[axis] : el.from[axis]);
            p.add(dir.clone().multiplyScalar(side * 0.8));
            cube.position.copy(p);
            cube.renderOrder = 20;
            cube.userData = { handle: { kind: "resize", axis, side } satisfies Handle };
            handles.add(cube);
            three.handles.push(cube);
          }
        }
      }
      three.overlay.add(handles);
    }
    void outlineMatrix;
    invalidate.current();
    return () => {
      for (const d of disposables) d.dispose();
    };
  }, [three, parts, images, selected, selectedFace, shading, showGrid, renderLayer, display, drag, gizmo, onTransform, loaded]);

  // ── Mouse: orbit/pan/zoom, pick, drag handles ─────────────────────────────

  const propsRef = useRef({ parts, onSelect, onTransform, selected });
  propsRef.current = { parts, onSelect, onTransform, selected };

  useEffect(() => {
    const host = hostRef.current!;
    const raycaster = new THREE.Raycaster();
    const ndc = (e: PointerEvent | MouseEvent) => {
      const r = host.getBoundingClientRect();
      return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    const camera = () => (ortho ? three.orth : three.persp);
    let mode: "orbit" | "pan" | "handle" | null = null;
    let last = { x: 0, y: 0 };
    let down = { x: 0, y: 0 };
    let handleDrag: { handle: Handle; el: Element; start: { x: number; y: number }; screenAxis: THREE.Vector2; pxPerUnit: number } | null = null;
    let live: { from: Vec3; to: Vec3 } | null = null;

    const onDown = (e: PointerEvent) => {
      host.focus();
      down = last = { x: e.clientX, y: e.clientY };
      if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) {
        mode = e.shiftKey ? "pan" : "orbit";
        host.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      raycaster.setFromCamera(ndc(e), camera());
      const hit = raycaster.intersectObjects(three.handles, false)[0];
      const { parts: ps, selected: sel } = propsRef.current;
      const editable = ps.find((p) => p.editable);
      if (hit && sel !== null && editable) {
        const handle = hit.object.userData.handle as Handle;
        const el = editable.elements[sel];
        // The axis on screen: project the handle point and a point one unit along the axis.
        const world = new THREE.Vector3();
        hit.object.getWorldPosition(world);
        const along = world.clone();
        const axisDir = new THREE.Vector3(handle.axis === 0 ? 1 : 0, handle.axis === 1 ? 1 : 0, handle.axis === 2 ? 1 : 0);
        axisDir.applyMatrix4(new THREE.Matrix4().extractRotation(stateMatrix(editable.x, editable.y)));
        along.add(axisDir);
        const r = host.getBoundingClientRect();
        const toScreen = (v: THREE.Vector3) => {
          const p = v.clone().project(camera());
          return new THREE.Vector2(((p.x + 1) / 2) * r.width, ((1 - p.y) / 2) * r.height);
        };
        const a = toScreen(world);
        const b = toScreen(along);
        const d = b.clone().sub(a);
        const len = d.length();
        if (len < 0.01) return;
        handleDrag = { handle, el, start: { x: e.clientX, y: e.clientY }, screenAxis: d.normalize(), pxPerUnit: len };
        mode = "handle";
        host.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!mode) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      if (mode === "orbit") {
        three.cam.theta -= dx * 0.01;
        three.cam.phi = Math.min(Math.PI - 0.01, Math.max(0.01, three.cam.phi - dy * 0.01));
        invalidate.current();
      } else if (mode === "pan") {
        const cam = camera();
        const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
        const k = three.cam.dist * 0.0018;
        three.cam.target.add(right.multiplyScalar(-dx * k)).add(up.multiplyScalar(dy * k));
        invalidate.current();
      } else if (mode === "handle" && handleDrag) {
        const { handle, el, start, screenAxis, pxPerUnit } = handleDrag;
        const moved = new THREE.Vector2(e.clientX - start.x, e.clientY - start.y).dot(screenAxis) / pxPerUnit;
        const step = e.shiftKey ? 0.25 : e.ctrlKey ? 0.001 : 1;
        const delta = Math.round(moved / step) * step;
        const from = [...el.from] as Vec3;
        const to = [...el.to] as Vec3;
        const clamp = (v: number) => Math.min(32, Math.max(-16, Math.round(v * 1000) / 1000));
        const i = handle.axis;
        if (handle.kind === "move") {
          const size = to[i] - from[i];
          from[i] = clamp(from[i] + delta);
          to[i] = from[i] + size;
          if (to[i] > 32) {
            to[i] = 32;
            from[i] = 32 - size;
          }
        } else if (handle.side === 1) to[i] = clamp(Math.max(from[i], to[i] + delta));
        else from[i] = clamp(Math.min(to[i], from[i] + delta));
        live = { from, to };
        setDrag({ index: propsRef.current.selected!, from, to });
      }
    };
    const onUp = (e: PointerEvent) => {
      const wasClick = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) < 4;
      if (mode === "handle" && live && propsRef.current.selected !== null) {
        propsRef.current.onTransform?.(propsRef.current.selected, live.from, live.to);
      }
      if (mode) {
        mode = null;
        handleDrag = null;
        live = null;
        setDrag(null);
        host.releasePointerCapture?.(e.pointerId);
        return;
      }
      if (e.button !== 0 || !wasClick) return;
      raycaster.setFromCamera(ndc(e), camera());
      const hits = raycaster.intersectObjects(three.model.children, true).filter((h) => h.object.userData.part === "edit");
      const hit = hits[0];
      if (hit) propsRef.current.onSelect(hit.object.userData.element as number, hit.object.userData.face as Dir);
      else propsRef.current.onSelect(null, null);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      three.cam.dist = Math.min(400, Math.max(4, three.cam.dist * Math.exp(e.deltaY * 0.001)));
      invalidate.current();
    };
    const onKey = (e: KeyboardEvent) => {
      const key = e.code.startsWith("Numpad") ? e.code.slice(6) : e.code.startsWith("Digit") ? e.code.slice(5) : "";
      const set = (v: ViewName) => {
        three.cam.theta = VIEWS[v].theta;
        three.cam.phi = VIEWS[v].phi;
        invalidate.current();
      };
      if (key === "1") set(e.ctrlKey ? "back" : "front");
      else if (key === "3") set(e.ctrlKey ? "left" : "right");
      else if (key === "7") set(e.ctrlKey ? "bottom" : "top");
      else if (key === "5") setOrtho((o) => !o);
      else if (key === "0" || e.code === "Home" || e.code === "NumpadDecimal" || e.code === "Period") {
        three.cam.target.copy(CENTER);
        three.cam.dist = 40;
        invalidate.current();
      } else if (key === "4" || key === "6") {
        three.cam.theta += (key === "4" ? -1 : 1) * (Math.PI / 12);
        invalidate.current();
      } else if (key === "8" || key === "2") {
        three.cam.phi = Math.min(Math.PI - 0.01, Math.max(0.01, three.cam.phi + (key === "8" ? -1 : 1) * (Math.PI / 12)));
        invalidate.current();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    const noMenu = (e: MouseEvent) => e.preventDefault();
    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("keydown", onKey);
    host.addEventListener("contextmenu", noMenu);
    return () => {
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("keydown", onKey);
      host.removeEventListener("contextmenu", noMenu);
    };
  }, [three, ortho]);

  return (
    <div
      ref={hostRef}
      className={className}
      tabIndex={0}
      style={{ position: "relative", overflow: "hidden", outline: "none", ...style }}
      data-ortho={ortho || undefined}
    >
      <div className="content-viewport-hud">{ortho ? "Ortho" : "Persp"}</div>
    </div>
  );
}

/** Normal of a face — for UI (which way a face points). */
export const faceNormal = (d: Dir) => DIR_NORMAL[d];
