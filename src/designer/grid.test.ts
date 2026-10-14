import { describe, expect, it } from "vitest";
import { cellOf, formatLength, gridDefs, parseLength, shiftCells, withGridDefs, type TrackDef } from "./grid";
import type { YuiNode } from "./yui";

let uid = 0;
const node = (kind: string, attrs: Record<string, string> = {}, children: YuiNode[] = []): YuiNode => ({ uid: `n${uid++}`, kind, attrs, children });
const star: TrackDef = { size: { t: "star", v: 1 }, min: null, max: null };

describe("grid", () => {
  it("reads and writes WPF lengths", () => {
    expect(["Auto", "auto", "*", "2*", " 1.5 * ", "26", "-1", "x"].map(parseLength)).toEqual([
      { t: "auto" },
      { t: "auto" },
      { t: "star", v: 1 },
      { t: "star", v: 2 },
      { t: "star", v: 1.5 },
      { t: "px", v: 26 },
      null,
      null,
    ]);
    expect(formatLength({ t: "star", v: 1 })).toBe("*");
    expect(formatLength({ t: "star", v: 2 })).toBe("2*");
    expect(formatLength({ t: "px", v: 1 / 3 })).toBe("0.333");
  });

  it("reads both forms, unreadable sizes as *", () => {
    const g = node("Grid", { rows: "Auto,bad,26" }, [
      node("Grid.ColumnDefinitions", {}, [node("ColumnDefinition", { width: "2*", min_width: "10" }), node("ColumnDefinition")]),
    ]);
    const { rows, cols } = gridDefs(g);
    expect(rows.map((r) => formatLength(r.size))).toEqual(["Auto", "*", "26"]);
    expect(cols).toEqual([{ size: { t: "star", v: 2 }, min: 10, max: null }, star]);
  });

  it("writes compact unless the file uses elements or a limit needs them", () => {
    const g = node("Grid", { rows: "*" }, [node("Button")]);
    const compact = withGridDefs(g, "rows", [star, { size: { t: "auto" }, min: null, max: null }]);
    expect(compact.attrs.rows).toBe("*,Auto");
    expect(compact.children.map((c) => c.kind)).toEqual(["Button"]);

    const limited = withGridDefs(compact, "rows", [{ ...star, min: 5 }]);
    expect(limited.attrs.rows).toBeUndefined();
    expect(limited.children[0].children[0].attrs).toEqual({ min_height: "5" });

    // Elements stay elements, keep their uids; columns go after the rows.
    const again = withGridDefs(limited, "rows", [star, star]);
    expect(again.children[0].uid).toBe(limited.children[0].uid);
    expect(again.children[0].children[0].uid).toBe(limited.children[0].children[0].uid);
    const cols = withGridDefs(withGridDefs(again, "cols", [{ ...star, max: 9 }]), "cols", [{ ...star, max: 9 }]);
    expect(cols.children.map((c) => c.kind)).toEqual(["Grid.RowDefinitions", "Grid.ColumnDefinitions", "Button"]);

    expect(withGridDefs(again, "rows", []).children.map((c) => c.kind)).toEqual(["Button"]);
  });

  it("moves children like Visual Studio when tracks come and go", () => {
    const g = node("Grid", {}, [
      node("Grid.RowDefinitions"),
      node("A", { "Grid.Row": "0", "Grid.RowSpan": "3" }),
      node("B", { "Grid.Row": "2" }),
      node("C", { "Grid.Row": "1" }),
    ]);
    const rows = (x: YuiNode) => x.children.slice(1).map((c) => [cellOf(c).row, cellOf(c).rowSpan]);
    expect(rows(shiftCells(g, "rows", 1, 1, 4))).toEqual([[0, 4], [3, 1], [2, 1]]);
    expect(rows(shiftCells(g, "rows", 1, -1, 2))).toEqual([[0, 2], [1, 1], [1, 1]]);
    expect(rows(shiftCells(g, "rows", 0, 0, 1))).toEqual([[0, 1], [0, 1], [0, 1]]);
    const removed = shiftCells(g, "rows", 0, -1, 2);
    expect(removed.children[2].attrs).toEqual({ "Grid.Row": "1" });
    expect(shiftCells(g, "rows", 0, 0, 1).children[1].attrs).toEqual({});
  });
});
