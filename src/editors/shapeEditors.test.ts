/**
 * The editors built on a format's shape (particles, sounds, textures,
 * definitions): each property, given every value its row lets through, must
 * leave a file the CLI's live check passes. A real mod's file is the start.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { PropertyDescriptor, PropertyValue } from "substrate-platform-ui";
import { describe, expect, it } from "vitest";
import { shapeProperties, type Described } from "../data/shapeGrid";
import { cliProblems, cliShape, cliValue, haveCli } from "../test/cliCheck";

type Obj = Record<string, unknown>;
const MODS = resolve(__dirname, "../../..");
const SAMPLES: [string, string][] = [
  [".yparticle", "HexMod-Yog/resources/particle/conjure_particle.yparticle"],
  [".ysound", "HexMod-Yog/resources/sound/abacus.ysound"],
  [".ytexture", "Yog-VLSI/resources/block/alu_side_diamond.ytexture"],
  [".ydef", "Yog-VLSI/content/cost.ydef"],
  [".ydef", "Yog-VLSI/content/tier.ydef"],
];
const t = (s: string) => s;

/** What a row lets through: every option, both truths, a number's bounds and its value. */
function valuesFor(row: PropertyDescriptor): PropertyValue[] {
  if (row.readOnly) return [];
  if (row.options) return [...row.options] as PropertyValue[];
  if (row.kind === "bool") return [true, false];
  const ok = (v: PropertyValue) => !row.validate || row.validate(v) === null;
  const candidates: PropertyValue[] = [row.value as PropertyValue, "", "0", "1", "-1", "0.5", "100"];
  return [...new Set(candidates.map(String))].filter(ok);
}

describe.skipIf(!haveCli)("shape-built editors' edits pass the CLI's check", () => {
  for (const [ext, sample] of SAMPLES) {
    it.skipIf(!existsSync(resolve(MODS, sample)))(`${sample}: every property, every value`, () => {
      const shape = cliShape(ext) as Described;
      const base = cliValue(resolve(MODS, sample)) as Obj;
      const found: string[] = [];
      let edits = 0;
      // A definition's kind switched is a new, unfinished file: its new fields are the user's to fill.
      const tag = (shape.defs[(shape.root as { name: string }).name] as { tag?: string }).tag;
      for (const row of shapeProperties(shape, base, () => {}, t).filter((r) => r.id !== tag)) {
        for (const v of valuesFor(row)) {
          let next: Obj = base;
          shapeProperties(shape, base, (n) => void (next = n), t)
            .find((r) => r.id === row.id)
            ?.onCommit?.(v);
          edits++;
          found.push(...cliProblems(`x${ext}`, next).map((m) => `${row.id} = ${JSON.stringify(v)}: ${m}`));
        }
      }
      expect(found).toEqual([]);
      expect(edits).toBeGreaterThan(0);
    });
  }
});
