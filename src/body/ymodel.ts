import { parseDataValue } from "../data/yogData";

// `.ymodel` — a body model (yog-body's `ModelFile`): bones in Java model
// space (pixels, y down, `CubeListBuilder`/`PartPose` numbers), each with a
// pivot, a rest turn in degrees, box-UV cubes and named locators. The
// geometry here is `yog_body::model::cube`, face for face.

export type Vec3 = [number, number, number];

export interface Cube {
  origin: Vec3;
  size: Vec3;
  uv: [number, number];
  inflate: number;
  mirror: boolean;
}

export interface Bone {
  name: string;
  parent: string | null;
  pivot: Vec3;
  /** Degrees. */
  rotation: Vec3;
  cubes: Cube[];
  locators: Record<string, Vec3>;
}

export interface ModelFile {
  texture: string;
  textureSize: [number, number];
  bones: Bone[];
}

const vec = (v: unknown, d: Vec3 = [0, 0, 0]): Vec3 =>
  Array.isArray(v) && v.length === 3 ? (v.map((n, i) => (typeof n === "number" ? n : d[i])) as Vec3) : [...d];

/** Reads a `.ymodel`; throws on text that isn't Yog Data. */
export function parseModel(text: string): ModelFile {
  const raw = (text.trim() ? parseDataValue(text) : {}) as Record<string, unknown>;
  const size = Array.isArray(raw.texture_size) ? raw.texture_size : [64, 32];
  const bones = (Array.isArray(raw.bones) ? raw.bones : []).map((b): Bone => {
    const o = (b ?? {}) as Record<string, unknown>;
    return {
      name: typeof o.name === "string" ? o.name : "bone",
      parent: typeof o.parent === "string" ? o.parent : null,
      pivot: vec(o.pivot),
      rotation: vec(o.rotation),
      cubes: (Array.isArray(o.cubes) ? o.cubes : []).map((c): Cube => {
        const k = (c ?? {}) as Record<string, unknown>;
        const uv = Array.isArray(k.uv) ? k.uv : [0, 0];
        return {
          origin: vec(k.origin),
          size: vec(k.size, [1, 1, 1]),
          uv: [Number(uv[0]) || 0, Number(uv[1]) || 0],
          inflate: typeof k.inflate === "number" ? k.inflate : 0,
          mirror: k.mirror === true,
        };
      }),
      locators: Object.fromEntries(
        Object.entries((o.locators ?? {}) as Record<string, unknown>).map(([n, p]) => [n, vec(p)])
      ),
    };
  });
  return {
    texture: typeof raw.texture === "string" ? raw.texture : "",
    textureSize: [Number(size[0]) || 64, Number(size[1]) || 32],
    bones,
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const nums = (v: number[]) => `[${v.map(round).join(", ")}]`;

/** Writes a `.ymodel`: fields at their defaults left out, numbers rounded. */
export function serializeModel(m: ModelFile): string {
  const lines: string[] = ["{"];
  lines.push(`  "texture": ${JSON.stringify(m.texture)},`);
  lines.push(`  "texture_size": ${nums(m.textureSize)},`);
  lines.push(`  "bones": [`);
  m.bones.forEach((b, bi) => {
    const fields: string[] = [`"name": ${JSON.stringify(b.name)}`];
    if (b.parent) fields.push(`"parent": ${JSON.stringify(b.parent)}`);
    if (b.pivot.some((n) => n !== 0)) fields.push(`"pivot": ${nums(b.pivot)}`);
    if (b.rotation.some((n) => n !== 0)) fields.push(`"rotation": ${nums(b.rotation)}`);
    const cubes = b.cubes.map((c) => {
      const f = [`"origin": ${nums(c.origin)}`, `"size": ${nums(c.size)}`];
      if (c.uv[0] || c.uv[1]) f.push(`"uv": ${nums(c.uv)}`);
      if (c.inflate) f.push(`"inflate": ${round(c.inflate)}`);
      if (c.mirror) f.push(`"mirror": true`);
      return `{ ${f.join(", ")} }`;
    });
    const locs = Object.entries(b.locators);
    lines.push(`    {`);
    const body = [...fields];
    if (cubes.length) body.push(`"cubes": [\n        ${cubes.join(",\n        ")}\n      ]`);
    if (locs.length) body.push(`"locators": { ${locs.map(([n, p]) => `${JSON.stringify(n)}: ${nums(p)}`).join(", ")} }`);
    lines.push(body.map((f) => `      ${f}`).join(",\n"));
    lines.push(`    }${bi < m.bones.length - 1 ? "," : ""}`);
  });
  lines.push(`  ]`);
  lines.push("}");
  return lines.join("\n") + "\n";
}

/** A new model: one root bone. */
export function blankModel(): ModelFile {
  return { texture: "", textureSize: [64, 32], bones: [{ name: "root", parent: null, pivot: [0, 0, 0], rotation: [0, 0, 0], cubes: [], locators: {} }] };
}

// ── Geometry (yog_body::model::cube) ────────────────────────────────────────

/** A face: corners (bone space, pixels), UVs (0–1, v down), normal. */
export interface Quad {
  pos: [Vec3, Vec3, Vec3, Vec3];
  uv: [[number, number], [number, number], [number, number], [number, number]];
  normal: Vec3;
}

/** `ModelPart.Cube`'s six faces: down, up, west, north, east, south. */
export function cubeQuads(c: Cube, texW: number, texH: number): Quad[] {
  const [x, y, z] = c.origin;
  const [w, h, d] = c.size;
  const [u, v] = c.uv;
  const g = c.inflate;
  let x0 = x - g;
  let x1 = x + w + g;
  const [y0, y1, z0, z1] = [y - g, y + h + g, z - g, z + d + g];
  if (c.mirror) [x0, x1] = [x1, x0];
  const p = (a: number, b: number, cc: number): Vec3 => [a, b, cc];
  const v7 = p(x0, y0, z0), v0 = p(x1, y0, z0), v1 = p(x1, y1, z0), v2 = p(x0, y1, z0);
  const v3 = p(x0, y0, z1), v4 = p(x1, y0, z1), v5 = p(x1, y1, z1), v6 = p(x0, y1, z1);
  const [u0, u1, u2, u3, u4, u5] = [u, u + d, u + d + w, u + d + w + w, u + d + w + d, u + d + w + d + w];
  const [t0, t1, t2] = [v, v + d, v + d + h];
  const face = (corners: Quad["pos"], ua: number, va: number, ub: number, vb: number, n: Vec3): Quad => {
    let pos = corners;
    let uv: Quad["uv"] = [
      [ub / texW, va / texH],
      [ua / texW, va / texH],
      [ua / texW, vb / texH],
      [ub / texW, vb / texH],
    ];
    let normal = n;
    if (c.mirror) {
      pos = [pos[3], pos[2], pos[1], pos[0]];
      uv = [uv[3], uv[2], uv[1], uv[0]];
      normal = [-n[0], n[1], n[2]];
    }
    return { pos, uv, normal };
  };
  return [
    face([v4, v3, v7, v0], u1, t0, u2, t1, [0, -1, 0]),
    face([v1, v2, v6, v5], u2, t1, u3, t0, [0, 1, 0]),
    face([v7, v3, v6, v2], u0, t1, u1, t2, [-1, 0, 0]),
    face([v0, v7, v2, v1], u1, t1, u2, t2, [0, 0, -1]),
    face([v4, v0, v1, v5], u2, t1, u4, t2, [1, 0, 0]),
    face([v3, v4, v5, v6], u4, t1, u5, t2, [0, 0, 1]),
  ];
}

/** Where each face of a cube sits on the texture (pixels), for the UV net. */
export function boxUvRects(c: Cube): { face: string; x: number; y: number; w: number; h: number }[] {
  const [w, h, d] = c.size;
  const [u, v] = c.uv;
  return [
    { face: "down", x: u + d, y: v, w, h: d },
    { face: "up", x: u + d + w, y: v, w, h: d },
    { face: "west", x: u, y: v + d, w: d, h },
    { face: "north", x: u + d, y: v + d, w, h },
    { face: "east", x: u + d + w, y: v + d, w: d, h },
    { face: "south", x: u + d + w + d, y: v + d, w, h },
  ];
}

// ── Editing ─────────────────────────────────────────────────────────────────

export function clone(m: ModelFile): ModelFile {
  return JSON.parse(JSON.stringify(m)) as ModelFile;
}

/** A bone name not taken yet, from `base`. */
export function freeName(m: ModelFile, base: string): string {
  if (!m.bones.some((b) => b.name === base)) return base;
  for (let i = 2; ; i++) if (!m.bones.some((b) => b.name === `${base}${i}`)) return `${base}${i}`;
}

/** Bones in the order a parent comes before its children (the format needs it). */
export function ordered(m: ModelFile): Bone[] {
  const out: Bone[] = [];
  const visit = (parent: string | null) => {
    for (const b of m.bones.filter((x) => x.parent === parent)) {
      out.push(b);
      visit(b.name);
    }
  };
  visit(null);
  // Bones whose parent is missing come last, as roots.
  for (const b of m.bones) if (!out.includes(b)) out.push(b);
  return out;
}

/** Renames a bone and every child that hangs on it. */
export function renameBone(m: ModelFile, from: string, to: string): void {
  for (const b of m.bones) {
    if (b.name === from) b.name = to;
    else if (b.parent === from) b.parent = to;
  }
}

/** Removes a bone; its children hang on its parent. */
export function removeBone(m: ModelFile, name: string): void {
  const gone = m.bones.find((b) => b.name === name);
  if (!gone) return;
  for (const b of m.bones) if (b.parent === name) b.parent = gone.parent;
  m.bones = m.bones.filter((b) => b !== gone);
}

/** Whether `ancestor` is `name` or above it. */
export function isAncestor(m: ModelFile, ancestor: string, name: string): boolean {
  for (let cur: string | null = name, i = 0; cur && i < 256; i++) {
    if (cur === ancestor) return true;
    cur = m.bones.find((b) => b.name === cur)?.parent ?? null;
  }
  return false;
}

/** A copy of `bone` mirrored left to right (`left_…` ↔ `right_…`). */
export function mirroredBone(m: ModelFile, bone: Bone): Bone {
  const swap = (s: string) =>
    s.replace(/left/g, "\u0000").replace(/right/g, "left").replace(/\u0000/g, "right").replace(/Left/g, "\u0001").replace(/Right/g, "Left").replace(/\u0001/g, "Right");
  const name = freeName(m, swap(bone.name) === bone.name ? `${bone.name}_mirrored` : swap(bone.name));
  return {
    name,
    parent: bone.parent && m.bones.some((b) => b.name === swap(bone.parent!)) ? swap(bone.parent) : bone.parent,
    pivot: [-bone.pivot[0], bone.pivot[1], bone.pivot[2]],
    rotation: [bone.rotation[0], -bone.rotation[1], -bone.rotation[2]],
    cubes: bone.cubes.map((c) => ({ ...c, origin: [-c.origin[0] - c.size[0], c.origin[1], c.origin[2]] as Vec3, mirror: !c.mirror })),
    locators: Object.fromEntries(Object.entries(bone.locators).map(([n, p]) => [n, [-p[0], p[1], p[2]] as Vec3])),
  };
}
