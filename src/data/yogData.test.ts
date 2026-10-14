import { describe, expect, it } from "vitest";
import { classify, DataSyntaxError, escapeAt, parseData, resourceId } from "./yogData";

const err = (text: string) => {
  try {
    parseData(text);
  } catch (e) {
    if (e instanceof DataSyntaxError) return `${e.line}:${e.col}: ${e.message}`;
    throw e;
  }
  throw new Error("parsed");
};

describe("yog data text", () => {
  it("reads the JSON5 subset with positions, duplicates kept", () => {
    const n = parseData('\ufeff{\n  // c\n  a: [1, 2.5, -3e2, true, null,],\n  "b": { "x": "y" }, /* z */\n  a: 0,\n}');
    if (n.t !== "map") throw new Error();
    expect(n.entries.map((e) => [e.key, e.keyLine])).toEqual([["a", 3], ["b", 4], ["a", 5]]);
    const list = n.entries[0].value;
    if (list.t !== "list") throw new Error();
    expect(list.items.map((i) => (i.t === "num" ? [i.v, i.int] : i.t))).toEqual([[1, true], [2.5, false], [-300, false], "bool", "null"]);
    expect(n.entries[1].value.line).toBe(4);
  });

  it("reports what and where, like the build", () => {
    expect(err('{"a": 1,, }')).toBe("1:9: expected a key");
    expect(err('{"a": 1 "b": 2}')).toBe("1:9: expected `,` or `}`");
    expect(err("[1, 2")).toBe("1:6: expected `,` or `]`, found the end of the file");
    expect(err('"ab\ncd"')).toBe("1:4: line break in a string (write `\\n`)");
    expect(err("'x'")).toBe("1:1: strings use double quotes");
    expect(err("01")).toBe("1:1: numbers don't start with 0");
    expect(err("{} x")).toBe("1:4: unexpected text after the value");
    expect(err('"\\q"')).toMatch(/^1:2: unknown escape/);
    expect(err("{\n  a: tru }")).toBe("2:6: expected a value");
    expect(err("[".repeat(300))).toMatch(/nested deeper/);
  });

  it("classifies typed strings like yog_data::typed", () => {
    expect(classify("plain")).toEqual({ t: "str", v: "plain" });
    expect(classify("@@me")).toEqual({ t: "str", v: "@me" });
    expect(classify("@item:stick")).toEqual({ t: "ref", kind: "item", id: "minecraft:stick" });
    expect(classify("@block:furnace[facing=north]")).toEqual({ t: "ref", kind: "block", id: "minecraft:furnace[facing=north]" });
    expect(classify("@tag:item:minecraft:planks")).toEqual({ t: "tag", kind: "item", id: "minecraft:planks" });
    expect(classify("@Strings.screen.title")).toEqual({ t: "res", set: "Strings", key: "screen.title" });
    expect(classify("@image:sprite:button")).toEqual({ t: "image", source: "sprite:button" });
    expect(classify("@lang:gui.done")).toEqual({ t: "lang", key: "gui.done" });
    for (const bad of ["@", "@stick", "@Item:stick", "@item:Stick", "@item:", "@tag:item", "@strings.title", "@Strings.", "@block:furnace[facing=north", "@image:", "@lang:", "@lang:a b", "@gui.done"]) {
      expect(() => classify(bad), bad).toThrow();
    }
    expect(resourceId("Gm:x")).toBeNull();
    expect(escapeAt("@x")).toBe("@@x");
  });
});
