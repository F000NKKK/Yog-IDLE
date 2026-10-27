import { describe, expect, it } from "vitest";
import { readData } from "./yogData";
import { classify, prefetchTyped } from "./typed";

describe("yog data", () => {
  it("reads through the CLI, maps in order when asked", async () => {
    expect(await readData("{ b: 1, a: [true, \"@item:x\"] }")).toEqual({ ok: true, value: { b: 1, a: [true, "@item:x"] } });
    const r = await readData('{ "1": 1, "0.5": { x: "y" } }', { ordered: true });
    expect(r.ok && [...(r.value as Map<string, unknown>).keys()]).toEqual(["1", "0.5"]);
    const bad = await readData("{ a: }");
    expect(!bad.ok && bad.error).toMatch(/^1:/);
  });

  it("classifies typed strings by the CLI", async () => {
    const good = ["@@me", "@item:stick", "@block:furnace[facing=north]", "@tag:item:minecraft:planks", "@res:Strings.screen.title", "@image:sprite:button", "@lang:gui.done"];
    const bad = ["@", "@stick", "@Item:stick", "@item:Stick", "@item:", "@tag:item", "@strings.title", "@Strings.", "@image:", "@lang:", "@gui.done"];
    expect(classify("plain")).toEqual({ t: "str", v: "plain" });
    expect(classify("@item:fresh").t).toBe("pending");
    await prefetchTyped([...good, ...bad]);
    // A string comes as spelled: the text `@me` is `@@me`.
    expect(classify("@@me")).toEqual({ t: "str", v: "@@me" });
    expect(classify("@item:stick")).toEqual({ t: "ref", kind: "item", id: "minecraft:stick" });
    expect(classify("@block:furnace[facing=north]")).toEqual({ t: "ref", kind: "block", id: "minecraft:furnace[facing=north]" });
    expect(classify("@tag:item:minecraft:planks")).toEqual({ t: "tag", kind: "item", id: "minecraft:planks" });
    expect(classify("@res:Strings.screen.title")).toEqual({ t: "res", set: "Strings", key: "screen.title" });
    expect(classify("@image:sprite:button")).toEqual({ t: "image", source: "sprite:button" });
    expect(classify("@lang:gui.done")).toEqual({ t: "lang", key: "gui.done" });
    for (const b of bad) expect(() => classify(b), b).toThrow();
  });
});
