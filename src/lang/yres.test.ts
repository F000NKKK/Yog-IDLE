import { describe, expect, it } from "vitest";
import { accessorName, coerceValue, parseYres, serializeYres, splitYresPath, textMap, translationKey, valueProblem, type YresEntry } from "./yres";

const entries = (text: string): YresEntry[] => {
  const r = parseYres(text);
  if (!r.ok) throw new Error(`${r.line}: ${r.error}`);
  return r.entries;
};

describe("yres", () => {
  it("keeps file order, integer-like names and duplicates", () => {
    const e = entries('{\n  "b": "B",\n  "10": "ten",\n  "2": "two",\n  "b": "again"\n}');
    expect(e.map((x) => x.name)).toEqual(["b", "10", "2", "b"]);
    expect(e.map((x) => x.line)).toEqual([2, 3, 4, 5]);
  });

  it("reads plain values and objects, typing them by default", () => {
    const e = entries(
      '\ufeff{ "t": "Hi\\n", "n": -1.5e2, "f": false, "img": { "type": "image", "value": "a.png", "texture": "gui/a" }, "c": { "value": 3, "comment": "x" } }'
    );
    expect(e.map((x) => [x.name, x.type, x.value])).toEqual([
      ["t", "string", "Hi\n"],
      ["n", "number", -150],
      ["f", "bool", false],
      ["img", "image", "a.png"],
      ["c", "number", 3],
    ]);
    expect(e[3].texture).toBe("gui/a");
    expect(e[4].comment).toBe("x");
  });

  it.each([
    ["", 1, "expected a value, found the end of the file"],
    ["[]", 1, "expected `{`"],
    ['{\n  "a": "x\n"}', 2, "line break in a string"],
    ['{\n  "a": nope\n}', 2, "expected a value"],
    ['{\n  "a": []\n}', 2, "must be a string, a number or true/false"],
    ['{\n  "a": { "colour": "x" }\n}', 2, "unknown field `colour`"],
    ['{\n  "a": { "type": "image" }\n}', 2, "missing `value`"],
    ['{\n  "a": { "type": "font", "value": "x" }\n}', 2, "unknown type `font`"],
    ['{ "a": "x" "b": "y" }', 1, "expected `,` or `}`"],
    ['{ "a": "x" } extra', 1, "unexpected text"],
    ['{\n  "a": "@Strings.x"\n}', 2, "expected plain text"],
    ['{\n  "a": "@nope"\n}', 2, "a reference is"],
    ['{ "a": "x",', 1, "found the end of the file"],
  ])("reports %j at line %i", (text, line, error) => {
    const r = parseYres(text);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.line).toBe(line);
      expect(r.error).toContain(error);
    }
  });

  it("reads comments, trailing commas, unquoted keys and `@@`", () => {
    const e = entries('{\n  // note\n  title: "@@me", /* x */\n  "n": 1,\n}');
    expect(e.map((x) => [x.name, x.value, x.line])).toEqual([
      ["title", "@me", 3],
      ["n", 1, 4],
    ]);
    expect(serializeYres(e)).toBe('{\n  "title": "@@me",\n  "n": { "type": "number", "value": 1 }\n}\n');
  });

  it("writes what it reads", () => {
    const text = '{\n  "title": "Hello \\"you\\"",\n  "n": { "type": "number", "value": 2 },\n  "s": { "type": "sound", "value": "a.ogg", "event": "ui.click", "subtitle": "sub" },\n  "k": { "value": "x", "key": "custom.key" }\n}\n';
    expect(serializeYres(entries(text))).toBe(text);
    expect(serializeYres([])).toBe("{\n}\n");
  });

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
    expect(valueProblem(e("image", "a.PNG"))).toBeUndefined();
    expect(valueProblem(e("file", " "))).toBeDefined();
    expect(coerceValue("number", " 4 ")).toBe(4);
    expect(coerceValue("number", "")).toBe(0);
    expect(coerceValue("bool", "Yes")).toBe(true);
    expect(coerceValue("color", "red")).toBe("#FFFFFF");
    expect(coerceValue("string", 3)).toBe("3");
  });

  it("maps texts, the first of a duplicate winning", () => {
    expect([...textMap(entries('{ "a": "1", "n": 2, "a": "3" }'))]).toEqual([["a", "1"]]);
  });
});
