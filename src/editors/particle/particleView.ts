// The particle preview's 3D view: a patch of ground a block per square,
// and the particles as the game draws them — each a quad facing the camera,
// its frame of the particle's pictures, its colour, opacity and turn, blended
// and depth-written as its `.yparticle` says.

import * as THREE from "three";
import type { Live, ParticleLook } from "./particleSim";

/** The ground: blocks a side, and its lines. */
const GROUND = 16;
const GROUND_COLOR = 0x4a4a4a;
const GROUND_SUB_COLOR = 0x3a3a3a;
/** The ground under the grid (stone), by day and at night. */
const DAY_GROUND = 0x7f7f7f;
const NIGHT_GROUND = 0x141414;
/** The sky behind, by day and at night (the game's clear sky and its night). */
const DAY_SKY = 0x78a7ff;
const NIGHT_SKY = 0x0b0d1a;
/** The ground sits this far under the grid. */
const FLOOR_BELOW_GRID = 0.001;
/** A particle that doesn't glow, at night: this much of its colour. */
const NIGHT_LIGHT = 0.15;
/** The game drops an opaque particle's pixels below this alpha. */
const OPAQUE_CUTOFF = 0.1;
/** The camera: its field, how near and far it sees, where it starts. */
const FOV = 50;
const NEAR = 0.01;
const FAR = 200;
const START_DISTANCE = 5;
const START_THETA = Math.PI * 0.75;
const START_PHI = Math.PI / 3;
/** How close to straight up or down the camera turns. */
const PHI_LIMIT = 0.05;
const MIN_DISTANCE = 0.5;
const MAX_DISTANCE = 60;
/** The most particles drawn at once. */
export const MAX_PARTICLES = 4000;
/** Vertices and indices a quad takes. */
const QUAD_VERTICES = 4;
const QUAD_INDICES = 6;

/** The particle's pictures side by side in one texture: `count` frames. */
export interface Frames {
  texture: THREE.Texture;
  count: number;
}

/** `images` side by side, each in a square of the largest's size, drawn pixel for pixel. */
export function framesOf(images: HTMLImageElement[]): Frames {
  const cell = Math.max(1, ...images.map((i) => Math.max(i.naturalWidth, i.naturalHeight)));
  const canvas = document.createElement("canvas");
  canvas.width = cell * Math.max(images.length, 1);
  canvas.height = cell;
  const g = canvas.getContext("2d");
  if (g) {
    g.imageSmoothingEnabled = false;
    images.forEach((img, i) => g.drawImage(img, i * cell, 0, cell, cell));
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  // Colours as they are, as the game blends them (no sRGB conversion).
  texture.colorSpace = THREE.NoColorSpace;
  return { texture, count: Math.max(images.length, 1) };
}

/** Where the camera is: around `target`, `dist` away. */
interface Orbit {
  theta: number;
  phi: number;
  dist: number;
  target: THREE.Vector3;
}

/** The view: its renderer, scene, camera and the particles' mesh. */
export class ParticleView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, NEAR, FAR);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  private readonly positions = new Float32Array(MAX_PARTICLES * QUAD_VERTICES * 3);
  private readonly uvs = new Float32Array(MAX_PARTICLES * QUAD_VERTICES * 2);
  private readonly colors = new Float32Array(MAX_PARTICLES * QUAD_VERTICES * 4);
  private readonly orbit: Orbit;
  private readonly ground = new THREE.MeshBasicMaterial({ color: DAY_GROUND });
  private frames = 1;

  constructor(canvas: HTMLCanvasElement, target: THREE.Vector3) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    // Colours as they are, as the game draws them.
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.orbit = { theta: START_THETA, phi: START_PHI, dist: START_DISTANCE, target };
    const grid = new THREE.GridHelper(GROUND, GROUND, GROUND_COLOR, GROUND_SUB_COLOR);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(GROUND, GROUND).rotateX(-Math.PI / 2), this.ground);
    // Under the grid's lines, not fighting them.
    floor.position.y = -FLOOR_BELOW_GRID;
    this.scene.add(floor, grid);
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("uv", new THREE.BufferAttribute(this.uvs, 2).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setIndex(quadIndices());
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  /** How the particles are drawn: blending, depth, cut-off. */
  setRender(render: ParticleLook["render"]) {
    const m = this.material;
    m.transparent = render.blend !== "opaque";
    m.alphaTest = render.blend === "opaque" ? OPAQUE_CUTOFF : 0;
    m.blending = render.blend === "additive" ? THREE.AdditiveBlending : THREE.NormalBlending;
    m.depthWrite = render.depth_write;
    m.needsUpdate = true;
  }

  /** The particles' pictures. */
  setFrames(frames: Frames) {
    this.material.map?.dispose();
    this.material.map = frames.texture;
    this.frames = frames.count;
    this.material.needsUpdate = true;
  }

  /** Turns the camera around its target, and nearer or farther. */
  turn(dTheta: number, dPhi: number, zoom = 1) {
    const o = this.orbit;
    o.theta += dTheta;
    o.phi = Math.min(Math.PI - PHI_LIMIT, Math.max(PHI_LIMIT, o.phi + dPhi));
    o.dist = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, o.dist * zoom));
  }

  resize(width: number, height: number) {
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }

  /** Draws `particles` `partial` of a tick past their last, by day or `night`. */
  draw(particles: readonly Live[], partial: number, night: boolean, glow: boolean) {
    this.place();
    // The game's colours as they are (no sRGB to linear conversion).
    this.scene.background = new THREE.Color().setHex(night ? NIGHT_SKY : DAY_SKY, THREE.LinearSRGBColorSpace);
    this.ground.color.setHex(night ? NIGHT_GROUND : DAY_GROUND, THREE.LinearSRGBColorSpace);
    const light = night && !glow ? NIGHT_LIGHT : 1;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const shown = Math.min(particles.length, MAX_PARTICLES);
    for (let i = 0; i < shown; i++) this.quad(i, particles[i], partial, right, up, light);
    this.geometry.setDrawRange(0, shown * QUAD_INDICES);
    for (const name of ["position", "uv", "color"]) this.geometry.getAttribute(name).needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  }

  /** The camera where its orbit says. */
  private place() {
    const { theta, phi, dist, target } = this.orbit;
    this.camera.position.set(
      target.x + dist * Math.sin(phi) * Math.cos(theta),
      target.y + dist * Math.cos(phi),
      target.z + dist * Math.sin(phi) * Math.sin(theta),
    );
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();
  }

  /** Particle `p`'s quad, the `i`th: facing the camera, turned by its roll. */
  private quad(i: number, p: Live, partial: number, right: THREE.Vector3, up: THREE.Vector3, light: number) {
    const cx = p.xo + (p.x - p.xo) * partial;
    const cy = p.yo + (p.y - p.yo) * partial;
    const cz = p.zo + (p.z - p.zo) * partial;
    const cos = Math.cos(p.roll), sin = Math.sin(p.roll), s = p.quadSize;
    const r = right.clone().multiplyScalar(cos).addScaledVector(up, sin).multiplyScalar(s);
    const u = up.clone().multiplyScalar(cos).addScaledVector(right, -sin).multiplyScalar(s);
    const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const u0 = p.frame / this.frames, u1 = (p.frame + 1) / this.frames;
    corners.forEach(([a, b], k) => {
      const v = i * QUAD_VERTICES + k;
      this.positions.set([cx + r.x * a + u.x * b, cy + r.y * a + u.y * b, cz + r.z * a + u.z * b], v * 3);
      this.uvs.set([a < 0 ? u0 : u1, b < 0 ? 0 : 1], v * 2);
      this.colors.set([p.rgb[0] * light, p.rgb[1] * light, p.rgb[2] * light, p.alpha], v * 4);
    });
  }

  dispose() {
    this.material.map?.dispose();
    this.material.dispose();
    this.ground.dispose();
    this.geometry.dispose();
    this.renderer.dispose();
  }
}

/** Two triangles a quad, for every quad there may be. */
function quadIndices(): THREE.BufferAttribute {
  const out = new Uint32Array(MAX_PARTICLES * QUAD_INDICES);
  for (let q = 0; q < MAX_PARTICLES; q++) {
    const v = q * QUAD_VERTICES;
    out.set([v, v + 1, v + 2, v, v + 2, v + 3], q * QUAD_INDICES);
  }
  return new THREE.BufferAttribute(out, 1);
}
