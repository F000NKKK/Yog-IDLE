import { describe, expect, it } from "vitest";
import { contentText } from "../bench/fixtures";
import { clone, parseContent, patchContent } from "./model";
import { renameProperty } from "./states";

function parsed(text: string): unknown {
  const r = parseContent(text);
  if (!r.ok) throw new Error(r.error);
  return r.file;
}

describe("parseContent", () => {
  it("drops comments and trailing commas", () => {
    expect(parsed('{\n  "a": [1, 2,], // two\n  "b": { "c": true, },\n}')).toEqual({ a: [1, 2], b: { c: true } });
    expect(parsed('{ "a": 1, // last\n}')).toEqual({ a: 1 });
    expect(parsed('{ "a": 1 } // no newline at the end')).toEqual({ a: 1 });
  });

  it("leaves string contents alone", () => {
    expect(parsed('{ "a": "x, ]", "b": "y,}", "c": "// kept", "d": "q\\", ]" }')).toEqual({ a: "x, ]", b: "y,}", c: "// kept", d: 'q", ]' });
  });

  it("reads the bench fixture", () => {
    const file = parsed(contentText(20)) as { name: string; model: { textures: Record<string, string>; elements: { faces: object }[] } };
    expect(file.name).toBe("@Strings.block.bench");
    expect(file.model.textures.note).toBe("a // not a comment, ]");
    expect(file.model.elements).toHaveLength(20);
    expect(Object.keys(file.model.elements[19].faces)).toEqual(["north", "south", "up"]);
  });
});

describe("editing a .yblock's text", () => {
  const text = `// A lamp.
{
  "block": { "powered": "lit" }, // redstone turns it on
  "states": {
    "properties": {
      /* On or off. */
      "lit": ["false", "true"]
    },
    "models": { "on": { "parent": "cube_all" } },
    "variants": { "lit=true": "on" }
  },
  "future_field": { "kept": true }
}
`;
  it("keeps comments and fields it doesn't know through a states edit", () => {
    const parsed = parseContent(text);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(patchContent(text, parsed.file)).toBe(text);
    const file = clone(parsed.file);
    renameProperty(file.states!, file.block, "lit", "powered");
    const out = patchContent(text, file);
    expect(out).toContain("// A lamp.");
    expect(out).toContain("// redstone turns it on");
    expect(out).toContain('/* On or off. */\n      "powered": ["false", "true"]');
    expect(out).toContain('"future_field": { "kept": true }');
    const again = parseContent(out);
    expect(again.ok && again.file).toEqual(file);
    expect(again.ok && again.file.states?.variants).toEqual({ "powered=true": "on" });
  });

  describe("block kinds and hanging items", () => {
    it("keeps the new loader properties in Yog Data round-trips", () => {
      const text = `// A built-in stair block.
  {
    "kind": "stairs",
    "block": { "base": "@block:mymod:planks", "occludes": true },
    "item": { "hangs": { "entity": "@entity:mymod:wall_scroll", "size": [2, 1] } }
  }
  `;
      const parsed = parseContent(text);
      if (!parsed.ok) throw new Error(parsed.error);
      expect(patchContent(text, parsed.file)).toBe(text);

      const draft = clone(parsed.file);
      draft.block!.base = "@block:minecraft:oak_planks";
      draft.item!.hangs!.size = [3, 2];
      const output = patchContent(text, draft);
      expect(output).toContain("// A built-in stair block.");
      expect(output).toContain('"base": "@block:minecraft:oak_planks"');
      expect(output).toContain('"size": [3, 2]');
      expect(parseContent(output)).toMatchObject({ ok: true, file: draft });
    });
  });
});
