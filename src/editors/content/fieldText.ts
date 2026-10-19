// Numbers, vectors and rotations as the Properties grid writes and reads them.

import type { StateRotation } from "../../content/model";

/** How many decimals a number in a field keeps. */
const DECIMALS = 1000;

/** The angles a block state turns by. */
const RIGHT_ANGLES = [0, 90, 180, 270];

export const fmt = (n: number) => String(Math.round(n * DECIMALS) / DECIMALS);
export const vecText = (v: readonly number[] | undefined) => (v ? v.map(fmt).join(", ") : "");

/** `n` numbers from `1, 2, 3` — or what's wrong: `"count"` (not `n` numbers) or `"range"`. */
export function parseVec(text: string, n: number, min = -Infinity, max = Infinity): number[] | "count" | "range" {
  const parts = text.split(/[,\s]+/).filter(Boolean).map(Number);
  if (parts.length !== n || parts.some((x) => Number.isNaN(x))) return "count";
  if (parts.some((x) => x < min || x > max)) return "range";
  return parts;
}

/** `0,90; 90,0` ↔ rotations. */
export const rotationsText = (r: StateRotation[] | undefined) => (r ?? []).map((x) => `${x.x ?? 0},${x.y ?? 0}${x.weight ? `*${x.weight}` : ""}`).join("; ");
export function parseRotations(text: string): StateRotation[] | string {
  const out: StateRotation[] = [];
  for (const part of text.split(";").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*,\s*(\d+)(?:\s*\*\s*(\d+))?$/.exec(part);
    if (!m) return "x,y pairs separated by ;, e.g. 0,0; 0,90; 0,180; 0,270";
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (!RIGHT_ANGLES.includes(x) || !RIGHT_ANGLES.includes(y)) return "angles must be 0, 90, 180 or 270";
    out.push({ ...(x ? { x } : {}), ...(y ? { y } : {}), ...(m[3] ? { weight: Number(m[3]) } : {}) });
  }
  return out;
}
