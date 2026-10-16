import { describe, expect, it } from "vitest";
import { formatData, parseData, parseDataValue, patchDataText, toOrdered } from "./yogData";

// A stand-in for an editor's formatter: JSON at the given indent.
const format = (v: unknown, level: number) => JSON.stringify(v, null, 2).replace(/\n/g, `\n${"  ".repeat(level)}`);
const patch = (text: string, edit: (v: Record<string, unknown>) => void) => {
  const v = parseDataValue(text) as Record<string, unknown>;
  edit(v);
  const out = patchDataText(text, v, format);
  expect(parseDataValue(out)).toEqual(v);
  return out;
};

const FILE = `// A block.
{
  "id": "lamp", // its id
  /* What it is. */
  "block": {
    "hardness": 4.0,
    "light": 15
  },
  "states": {
    "properties": {
      // On or off.
      "lit": ["false", "true"],
    },
  },
}
`;

describe("patching yog data text", () => {
  it("keeps the text when nothing changes", () => {
    expect(patch(FILE, () => {})).toBe(FILE);
  });

  it("changes a value in place, comments and number spelling kept", () => {
    const out = patch(FILE, (v) => ((v.block as Record<string, unknown>).light = 7));
    expect(out).toBe(FILE.replace('"light": 15', '"light": 7'));
  });

  it("adds a key after the others at their indent", () => {
    const out = patch(FILE, (v) => ((v.block as Record<string, unknown>).sound = "stone"));
    expect(out).toContain('"light": 15,\n    "sound": "stone"\n  },');
    expect(out).toContain("// its id");
  });

  it("removes a key with the comments above it, its neighbours' kept", () => {
    const out = patch(FILE, (v) => delete v.block);
    expect(out).not.toContain("What it is.");
    expect(out).toContain('"id": "lamp", // its id');
    expect(out).toContain("// On or off.");
  });

  it("removes the last key, the comma before it with it", () => {
    const out = patch('{\n  "a": 1, // one\n  "b": 2\n}', (v) => delete v.b);
    expect(out).toBe('{\n  "a": 1 // one\n}');
  });

  it("puts the comma before a line comment when a key is added after it", () => {
    const out = patch('{\n  "a": 1 // one\n}', (v) => (v.b = 2));
    expect(out).toBe('{\n  "a": 1, // one\n  "b": 2\n}');
  });

  it("renames a key in place, its comments and value text kept", () => {
    const out = patch(FILE, (v) => {
      const props = (v.states as { properties: Record<string, string[]> }).properties;
      props.on = props.lit;
      delete props.lit;
    });
    expect(out).toContain('// On or off.\n      "on": ["false", "true"],');
    expect(out).not.toContain('"lit"');
  });

  it("adds and removes list items, the others' text kept", () => {
    const text = '{\n  "list": [\n    // first\n    { "a": 1 },\n    { "b": 2 }\n  ]\n}';
    const out = patch(text, (v) => (v.list as unknown[]).push({ c: 3 }));
    expect(out).toContain("// first");
    const out2 = patch(text, (v) => (v.list as unknown[]).splice(0, 1));
    expect(out2).not.toContain("first");
    expect(out2).toContain('{ "b": 2 }');
  });

  it("writes a broken text anew", () => {
    expect(patchDataText("{ oops", { a: 1 }, format)).toBe('{\n  "a": 1\n}\n');
  });

  it("keeps the order of a Map's keys, numbers among them", () => {
    const text = '{\n  "rotation": {\n    "0": [0, 0, 0], // rest\n    "0.5": [45, 0, 0],\n    "1": [0, 0, 0]\n  }\n}';
    const doc = toOrdered(parseData(text)) as Map<string, Map<string, unknown>>;
    const keys = doc.get("rotation")!;
    keys.set("0.5", [90, 0, 0]);
    const out = patchDataText(text, doc, formatData);
    expect(out).toBe(text.replace("[45, 0, 0]", "[90, 0, 0]"));
    // A key added between others stays there.
    const between = new Map([...keys.entries()].flatMap(([k, v]) => (k === "1" ? [["0.75", [10, 0, 0]] as [string, unknown], [k, v]] : [[k, v]])));
    doc.set("rotation", between as Map<string, unknown>);
    const out2 = patchDataText(text, doc, formatData);
    expect(out2.indexOf('"0.75"')).toBeLessThan(out2.indexOf('"1"'));
    expect(out2).toContain("// rest");
  });

  it("formats a Map in its order", () => {
    expect(formatData(new Map([["1", 1], ["0.5", 2]]), 0)).toBe('{ "1": 1, "0.5": 2 }');
  });
});
