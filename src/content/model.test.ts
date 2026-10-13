import { describe, expect, it } from "vitest";
import { contentText } from "../bench/fixtures";
import { parseContent } from "./model";

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
