import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { eventKey } from "substrate-platform-ui";
import { cubeQuads, type ModelFile, type Vec3 } from "./ymodel";

// The body model editor's 3D view. The model is drawn in its own Java model
// space — pixels, y down, origin 24 px above the feet — with the camera's up
// pointing to −y, so it stands upright and the numbers the gizmos change are
// the file's. Bones are nested groups (pivot, ZYX turn — `ModelPart`), cubes
// box-UV faces with nearest filtering. Middle drag orbits, Shift+middle (or
// right) pans, the wheel zooms; numpad 1/3/7 front/side/top (Ctrl: the
// other side); G/R/S move, turn, scale with the gizmo.

/** What's selected: a bone, one of its cubes, or one of its locators. */
export type Selection =
  | { kind: "bone"; bone: string }
  | { kind: "cube"; bone: string; cube: number }
  | { kind: "locator"; bone: string; locator: string }
  | null;

export type GizmoMode = "translate" | "rotate" | "scale";

/** A pose to show on top of the rest (animation preview): per bone, radians, pixels, factor. */
export type PoseOverride = Record<string, { rotation: Vec3; position: Vec3; scale: Vec3 }>;

/**
 * What's drawn around the model, in blocks (16 px): an entity's hitbox
 * standing on the feet (its eye height a line across it), and a hanging
 * thing's wall — `width`×`height` whole blocks behind it.
 */
export interface ViewOverlay {
  hitbox?: { width: number; height: number; eye?: number };
  wall?: { width: number; height: number };
}

export interface ModelViewportProps {
  model: ModelFile;
  /** The texture as a data URL (none: a checkerboard). */
  texture: string | null;
  selection: Selection;
  onSelect: (s: Selection) => void;
  /** A finished gizmo drag: the bone's new pivot/turn (degrees)/scale, or a cube's origin/size, or a locator's place. */
  onBone: (bone: string, pivot: Vec3, rotation: Vec3) => void;
  onCube: (bone: string, cube: number, origin: Vec3, size: Vec3) => void;
  onLocator: (bone: string, locator: string, at: Vec3) => void;
  mode: GizmoMode;
  onMode: (m: GizmoMode) => void;
  /** Snap: pixels for moves, degrees for turns (0: free). */
  snap: { move: number; turn: number };
  showGrid: boolean;
  pose?: PoseOverride | null;
  overlay?: ViewOverlay;
  style?: CSSProperties;
  className?: string;
}

const ACCENT = 0x3b8eea;
const HITBOX = 0xffffff;
const EYE = 0xff4040;
const WALL = 0x8a7a64;
const FEET = 24;
/** Pixels a block. */
const BLOCK = 16;
const deg = THREE.MathUtils.degToRad;
const rad2deg = THREE.MathUtils.radToDeg;

function checker(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 2;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f800f8";
  g.fillRect(0, 0, 2, 2);
  g.fillStyle = "#000";
  g.fillRect(0, 0, 1, 1);
  g.fillRect(1, 1, 1, 1);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.repeat.set(16, 16);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Minecraft-like face shading by the face's (bone-space) normal. */
function shade(n: Vec3): number {
  if (n[1] < -0.5) return 1; // up (y down in model space)
  if (n[1] > 0.5) return 0.5;
  if (Math.abs(n[2]) > 0.5) return 0.8;
  return 0.6;
}

function cubeGeometry(model: ModelFile, cubes: ModelFile["bones"][number]["cubes"], index: number): THREE.BufferGeometry {
  const [tw, th] = model.textureSize;
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = cubes[index];
  for (const q of cubeQuads(c, tw, th)) {
    const base = pos.length / 3;
    const s = shade(q.normal);
    for (let i = 0; i < 4; i++) {
      pos.push(...q.pos[i]);
      uv.push(q.uv[i][0], 1 - q.uv[i][1]);
      col.push(s, s, s);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

interface Three {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  orbit: OrbitControls;
  gizmo: TransformControls;
  root: THREE.Group;
  grid: THREE.GridHelper;
  checker: THREE.Texture;
  /** Bone name → its group. */
  bones: Map<string, THREE.Group>;
  /** The object the gizmo moves (a bone's group, or a proxy for a cube/locator). */
  target: THREE.Object3D | null;
  frame: number;
}

export function ModelViewport(props: ModelViewportProps) {
  const { model, texture, selection, mode, onMode, snap, showGrid, pose, overlay } = props;
  const posed = !!pose;
  const hostRef = useRef<HTMLDivElement>(null);
  const [three, setThree] = useState<Three | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const draw = useRef<() => void>(() => {});

  // ── The scene, once ─────────────────────────────────────────────────────

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x2a2a2e);
    Object.assign(renderer.domElement.style, { width: "100%", height: "100%", display: "block" });
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 2000);
    camera.up.set(0, -1, 0);
    camera.position.set(0, 0, -64);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, 12, 0);
    orbit.mouseButtons = { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    orbit.enableDamping = false;
    orbit.update();
    const root = new THREE.Group();
    scene.add(root);
    // The ground the feet stand on, 1 px cells.
    const grid = new THREE.GridHelper(64, 64, 0x666666, 0x3a3a3a);
    grid.position.y = FEET;
    scene.add(grid);
    const axes = new THREE.AxesHelper(8);
    axes.position.y = FEET;
    scene.add(axes);
    const gizmo = new TransformControls(camera, renderer.domElement);
    gizmo.setSpace("local");
    scene.add(gizmo.getHelper());
    const t: Three = { scene, camera, renderer, orbit, gizmo, root, grid, checker: checker(), bones: new Map(), target: null, frame: 0 };

    const render = () => {
      t.frame = 0;
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    };
    draw.current = () => {
      if (!t.frame) t.frame = requestAnimationFrame(render);
    };
    orbit.addEventListener("change", () => draw.current());
    gizmo.addEventListener("change", () => draw.current());
    gizmo.addEventListener("dragging-changed", (e) => {
      orbit.enabled = !e.value;
      if (!e.value) commit(t);
    });
    const ro = new ResizeObserver(() => draw.current());
    ro.observe(host);
    setThree(t);
    draw.current();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(t.frame);
      gizmo.dispose();
      orbit.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  /** A finished drag: the gizmo's object back into the file's numbers. */
  const commit = (t: Three) => {
    const p = propsRef.current;
    const sel = p.selection;
    const obj = t.target;
    if (!sel || !obj) return;
    const r = (n: number) => Math.round(n * 1000) / 1000;
    if (sel.kind === "bone") {
      const e = obj.rotation;
      p.onBone(sel.bone, [r(obj.position.x), r(obj.position.y), r(obj.position.z)], [r(rad2deg(e.x)), r(rad2deg(e.y)), r(rad2deg(e.z))]);
    } else if (sel.kind === "cube") {
      const c = p.model.bones.find((b) => b.name === sel.bone)?.cubes[sel.cube];
      if (!c) return;
      const size: Vec3 = [r(c.size[0] * obj.scale.x), r(c.size[1] * obj.scale.y), r(c.size[2] * obj.scale.z)];
      p.onCube(sel.bone, sel.cube, [r(obj.position.x), r(obj.position.y), r(obj.position.z)], size);
    } else {
      p.onLocator(sel.bone, sel.locator, [r(obj.position.x), r(obj.position.y), r(obj.position.z)]);
    }
  };

  // ── Texture ─────────────────────────────────────────────────────────────

  const [map, setMap] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    if (!texture) {
      setMap(null);
      return;
    }
    const tex = new THREE.TextureLoader().load(texture, () => draw.current());
    tex.magFilter = tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    setMap(tex);
    return () => tex.dispose();
  }, [texture]);

  // ── The model ───────────────────────────────────────────────────────────

  const material = useMemo(
    () => (three ? new THREE.MeshBasicMaterial({ map: map ?? three.checker, vertexColors: true, alphaTest: 0.1, side: THREE.DoubleSide, transparent: false }) : null),
    [three, map],
  );

  useEffect(() => {
    if (!three || !material) return;
    const t = three;
    const disposables: { dispose(): void }[] = [];
    t.root.clear();
    t.bones.clear();
    t.grid.visible = showGrid;
    // Parents before children; an unknown parent hangs on the root.
    const pending = [...model.bones];
    for (let guard = 0; pending.length && guard < 512; guard++) {
      const i = pending.findIndex((b) => !b.parent || t.bones.has(b.parent) || !model.bones.some((o) => o.name === b.parent));
      const b = pending.splice(i < 0 ? 0 : i, 1)[0];
      const g = new THREE.Group();
      g.position.set(...b.pivot);
      g.rotation.set(deg(b.rotation[0]), deg(b.rotation[1]), deg(b.rotation[2]), "ZYX");
      g.userData = { bone: b.name };
      (b.parent && t.bones.get(b.parent) ? t.bones.get(b.parent)! : t.root).add(g);
      t.bones.set(b.name, g);
      b.cubes.forEach((c, ci) => {
        const geo = cubeGeometry(model, b.cubes, ci);
        disposables.push(geo);
        const mesh = new THREE.Mesh(geo, material);
        mesh.userData = { bone: b.name, cube: ci };
        g.add(mesh);
        const selected = selection?.kind === "cube" && selection.bone === b.name && selection.cube === ci;
        const ofBone = selection?.kind === "bone" && selection.bone === b.name;
        if (selected || ofBone) {
          const g0 = c.inflate;
          const box = new THREE.Box3(
            new THREE.Vector3(c.origin[0] - g0, c.origin[1] - g0, c.origin[2] - g0),
            new THREE.Vector3(c.origin[0] + c.size[0] + g0, c.origin[1] + c.size[1] + g0, c.origin[2] + c.size[2] + g0),
          );
          const helper = new THREE.Box3Helper(box, selected ? ACCENT : 0x88aacc);
          (helper.material as THREE.LineBasicMaterial).depthTest = false;
          helper.renderOrder = 10;
          g.add(helper);
          disposables.push(helper.geometry);
        }
      });
      for (const [name, at] of Object.entries(b.locators)) {
        const dot = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.6),
          new THREE.MeshBasicMaterial({ color: selection?.kind === "locator" && selection.locator === name && selection.bone === b.name ? ACCENT : 0xf0b429, depthTest: false }),
        );
        dot.renderOrder = 12;
        dot.position.set(...at);
        dot.userData = { bone: b.name, locator: name };
        g.add(dot);
        disposables.push(dot.geometry, dot.material as THREE.Material);
      }
      if (selection && "bone" in selection && selection.bone === b.name) {
        const pivot = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false }));
        pivot.renderOrder = 12;
        g.add(pivot);
        disposables.push(pivot.geometry, pivot.material as THREE.Material);
      }
    }

    // The hitbox on the feet, the eyes across it; a hanging thing's wall behind.
    if (overlay?.hitbox) {
      const { width, height, eye } = overlay.hitbox;
      const w = (width * BLOCK) / 2;
      const top = FEET - height * BLOCK;
      const box = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(-w, top, -w), new THREE.Vector3(w, FEET, w)), HITBOX);
      t.root.add(box);
      disposables.push(box.geometry, box.material as THREE.Material);
      if (eye !== undefined) {
        const y = FEET - eye * BLOCK;
        const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-w, y, -w), new THREE.Vector3(w, y, -w), new THREE.Vector3(w, y, w), new THREE.Vector3(-w, y, w), new THREE.Vector3(-w, y, -w)]);
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: EYE }));
        t.root.add(line);
        disposables.push(geo, line.material as THREE.Material);
      }
    }
    if (overlay?.wall) {
      const { width, height } = overlay.wall;
      const [w, h] = [width * BLOCK, height * BLOCK];
      // Its front looks to −z, as the model's: the wall is just behind.
      const geo = new THREE.PlaneGeometry(w, h, Math.max(1, width), Math.max(1, height));
      const wall = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: WALL, side: THREE.DoubleSide, transparent: true, opacity: 0.35 }));
      wall.position.set(0, FEET - h / 2, 1);
      const cells = new THREE.LineSegments(new THREE.WireframeGeometry(geo), new THREE.LineBasicMaterial({ color: WALL }));
      wall.add(cells);
      t.root.add(wall);
      disposables.push(geo, wall.material as THREE.Material, cells.geometry, cells.material as THREE.Material);
    }

    // The gizmo: on the bone itself, or on a proxy at the cube/locator.
    t.gizmo.detach();
    t.target = null;
    if (selection && !posed) {
      const g = t.bones.get(selection.bone);
      if (g) {
        if (selection.kind === "bone") {
          t.target = g;
        } else {
          const proxy = new THREE.Object3D();
          if (selection.kind === "cube") {
            const c = model.bones.find((b) => b.name === selection.bone)?.cubes[selection.cube];
            if (c) proxy.position.set(...c.origin);
          } else {
            const at = model.bones.find((b) => b.name === selection.bone)?.locators[selection.locator];
            if (at) proxy.position.set(...at);
          }
          g.add(proxy);
          t.target = proxy;
        }
        t.gizmo.attach(t.target);
      }
    }
    draw.current();
    return () => {
      for (const d of disposables) d.dispose();
    };
  }, [three, material, model, selection, showGrid, posed, overlay]);

  // The pose on top of each bone's rest — every frame of a clip, without
  // building the model again.
  useEffect(() => {
    if (!three) return;
    for (const b of model.bones) {
      const g = three.bones.get(b.name);
      if (!g) continue;
      const extra = pose?.[b.name];
      g.position.set(b.pivot[0] + (extra?.position[0] ?? 0), b.pivot[1] + (extra?.position[1] ?? 0), b.pivot[2] + (extra?.position[2] ?? 0));
      g.rotation.set(deg(b.rotation[0]) + (extra?.rotation[0] ?? 0), deg(b.rotation[1]) + (extra?.rotation[1] ?? 0), deg(b.rotation[2]) + (extra?.rotation[2] ?? 0), "ZYX");
      g.scale.set(...(extra?.scale ?? [1, 1, 1]));
    }
    draw.current();
  }, [three, material, model, selection, showGrid, posed, overlay, pose]);

  // ── Gizmo mode and snapping ─────────────────────────────────────────────

  useEffect(() => {
    if (!three) return;
    const kind = selection?.kind;
    // A cube scales (its size), a bone turns, a locator only moves.
    const m: GizmoMode = kind === "locator" ? "translate" : kind === "cube" && mode === "rotate" ? "translate" : kind === "bone" && mode === "scale" ? "translate" : mode;
    three.gizmo.setMode(m);
    three.gizmo.setTranslationSnap(snap.move || null);
    three.gizmo.setRotationSnap(snap.turn ? deg(snap.turn) : null);
    three.gizmo.setScaleSnap(null);
    draw.current();
  }, [three, mode, snap, selection]);

  // ── Picking and keys ────────────────────────────────────────────────────

  useEffect(() => {
    if (!three) return;
    const el = three.renderer.domElement;
    const ray = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0 || !down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
      down = null;
      if (moved || three.gizmo.dragging) return;
      if ((three.gizmo as unknown as { axis: string | null }).axis) return;
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), three.camera);
      const hit = ray.intersectObjects(three.root.children, true).find((h) => h.object.userData.bone !== undefined && (h.object.userData.cube !== undefined || h.object.userData.locator !== undefined));
      const p = propsRef.current;
      if (!hit) return p.onSelect(null);
      const u = hit.object.userData;
      if (u.locator !== undefined) return p.onSelect({ kind: "locator", bone: u.bone, locator: u.locator });
      // A second click on a selected cube selects its bone (Blender's parent pick), Alt picks the bone straight away.
      const sel = p.selection;
      if (e.altKey || (sel?.kind === "cube" && sel.bone === u.bone && sel.cube === u.cube)) return p.onSelect({ kind: "bone", bone: u.bone });
      p.onSelect({ kind: "cube", bone: u.bone, cube: u.cube });
    };
    const view = (dir: Vec3, up: Vec3 = [0, -1, 0]) => {
      const d = three.camera.position.distanceTo(three.orbit.target);
      three.camera.position.set(three.orbit.target.x + dir[0] * d, three.orbit.target.y + dir[1] * d, three.orbit.target.z + dir[2] * d);
      three.camera.up.set(...up);
      three.orbit.update();
      draw.current();
    };
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable;
      if (typing || !el.isConnected || !el.matches(":hover")) return;
      // The physical key, whatever the layout types there ("п" is still G).
      const k = e.code === "NumpadDecimal" ? "." : eventKey(e);
      const flip = e.ctrlKey ? -1 : 1;
      if (k === "g") onMode("translate");
      else if (k === "r") onMode("rotate");
      else if (k === "s") onMode("scale");
      // Front: the model's face looks to −z.
      else if (k === "1") view([0, 0, -flip]);
      else if (k === "3") view([flip, 0, 0]);
      else if (k === "7") view([0, -flip, 0], [0, 0, 1]);
      else if (k === ".") {
        three.orbit.target.set(0, 12, 0);
        view([0, 0, -1]);
      } else return;
      e.preventDefault();
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [three, onMode]);

  return <div ref={hostRef} className={props.className} style={{ position: "relative", overflow: "hidden", ...props.style }} />;
}
