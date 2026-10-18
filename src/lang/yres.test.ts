import { describe, expect, it } from "vitest";
import { coerceValue, DEFAULT_COLOR, parseYres, splitYresPath, textMap, type YresEntry } from "./yres";

describe("yres", () => {
  it("splits paths by set and locale", () => {
    expect(splitYresPath("res/Items.ru_ru.yres")).toEqual({ dir: "res", set: "Items", locale: "ru_ru", sep: "/" });
    expect(splitYresPath("C:\\m\\Gui.yres")).toEqual({ dir: "C:\\m", set: "Gui", locale: null, sep: "\\" });
    expect(splitYresPath("res/My.Set.yres").set).toBe("My.Set");
  });

  it("gets names, accessors and keys from the CLI, as `yog build` makes them", async () => {
    const p = await parseYres('{ "screen.title": "a", "cad.0_x": "b", "ruby": { "type": "string", "value": "c", "key": "x.y" }, "1a": "d" }', { set: "Items", mod: "gm" });
    if (!p.ok) throw new Error(p.error);
    expect(p.entries.map((e) => e.accessor)).toEqual(["screen_title", "cad_0_x", "ruby", "1a"]);
    expect(p.entries.map((e) => !!e.nameProblem)).toEqual([false, false, false, true]);
    expect(p.entries.map((e) => e.translationKey)).toEqual(["item.gm.screen.title", "item.gm.cad.0_x", "x.y", "item.gm.1a"]);
  });

  it("checks values by the CLI's rule, and converts them by type", async () => {
    const p = await parseYres('{ "a": { "type": "color", "value": "#123" }, "b": { "type": "color", "value": "#80FF0000" }, "n": 3 }');
    if (!p.ok) throw new Error(p.error);
    expect(p.entries[0].valueProblem).toBeDefined();
    expect(p.entries[1]).toMatchObject({ argb: 0x80ff0000 });
    expect(p.entries[1].valueProblem).toBeUndefined();
    expect(coerceValue("number", " 4 ")).toBe(4);
    expect(coerceValue("number", "")).toBe(0);
    expect(coerceValue("bool", "Yes")).toBe(true);
    expect(coerceValue("color", "")).toBe(DEFAULT_COLOR);
    expect(coerceValue("string", 3)).toBe("3");
  });

  it("maps texts, the first of a duplicate winning", () => {
    const list: YresEntry[] = [
      { name: "a", type: "string", value: "1" },
      { name: "n", type: "number", value: 2 },
      { name: "a", type: "string", value: "3" },
    ];
    expect([...textMap(list)]).toEqual([["a", "1"]]);
  });
});
