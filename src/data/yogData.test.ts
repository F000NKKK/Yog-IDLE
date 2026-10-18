import { describe, expect, it } from "vitest";
import { classify, escapeAt, readData, resourceId } from "./yogData";

describe("yog data", () => {
  it("reads through the CLI, maps in order when asked", async () => {
    expect(await readData("{ b: 1, a: [true, \"@item:x\"] }")).toEqual({ ok: true, value: { b: 1, a: [true, "@item:x"] } });
    const r = await readData('{ "1": 1, "0.5": { x: "y" } }', { ordered: true });
    expect(r.ok && [...(r.value as Map<string, unknown>).keys()]).toEqual(["1", "0.5"]);
    const bad = await readData("{ a: }");
    expect(!bad.ok && bad.error).toMatch(/^1:/);
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
