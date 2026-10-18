import { describe, expect, it } from "vitest";
import { accessorName, coerceValue, splitYresPath, textMap, translationKey, valueProblem, type YresEntry } from "./yres";

describe("yres", () => {
  it("splits paths by set and locale", () => {
    expect(splitYresPath("res/Items.ru_ru.yres")).toEqual({ dir: "res", set: "Items", locale: "ru_ru", sep: "/" });
    expect(splitYresPath("C:\\m\\Gui.yres")).toEqual({ dir: "C:\\m", set: "Gui", locale: null, sep: "\\" });
    expect(splitYresPath("res/My.Set.yres").set).toBe("My.Set");
  });

  it("names accessors and keys like `yog build`", () => {
    expect(accessorName("screen.title")).toBe("screen_title");
    expect(accessorName("ModName")).toBe("mod_name");
    expect(translationKey("Items", { name: "ruby" }, "gm")).toBe("item.gm.ruby");
    expect(translationKey("Gui", { name: "title" }, "gm")).toBe("gm.title");
    expect(translationKey("Items", { name: "ruby", key: "x.y" }, "gm")).toBe("x.y");
  });

  it("checks and converts values by type", () => {
    const e = (type: YresEntry["type"], value: YresEntry["value"]): YresEntry => ({ name: "a", type, value });
    expect(valueProblem(e("color", "#12345678"))).toBeUndefined();
    expect(valueProblem(e("color", "#123"))).toBeDefined();
    expect(valueProblem(e("number", Number.NaN))).toBeDefined();
    expect(valueProblem(e("image", "@bytes:iVBORw0KGgo="))).toBeUndefined();
    expect(valueProblem(e("image", "a.png"))).toBeDefined();
    expect(valueProblem(e("file", " "))).toBeDefined();
    expect(coerceValue("number", " 4 ")).toBe(4);
    expect(coerceValue("number", "")).toBe(0);
    expect(coerceValue("bool", "Yes")).toBe(true);
    expect(coerceValue("color", "red")).toBe("#FFFFFF");
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
