import { describe, expect, it } from "vitest";
import { layoutTree, type AdvNode } from "./defModel";

const tree = (pairs: [string, string | null][]): AdvNode[] => pairs.map(([id, parent]) => ({ id, parent }));

describe("advancement layout (the game's TreeNodePosition)", () => {
  it("centres a parent on its children", () => {
    const at = layoutTree(tree([["r", null], ["a", "r"], ["b", "r"], ["c", "r"]]));
    expect(at.get("r")).toEqual({ x: 0, y: 1 });
    expect([at.get("a"), at.get("b"), at.get("c")]).toEqual([{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }]);
  });

  it("keeps subtrees apart", () => {
    const at = layoutTree(tree([["r", null], ["a", "r"], ["a1", "a"], ["a2", "a"], ["b", "r"]]));
    expect(at.get("a1")).toEqual({ x: 2, y: 0 });
    expect(at.get("a2")).toEqual({ x: 2, y: 1 });
    expect(at.get("a")).toEqual({ x: 1, y: 0.5 });
    expect(at.get("b")).toEqual({ x: 1, y: 1.5 });
    expect(at.get("r")).toEqual({ x: 0, y: 1 });
  });

  it("puts what a cycle leaves out in a column of its own", () => {
    const at = layoutTree(tree([["a", "b"], ["b", "a"]]));
    expect(at.size).toBe(2);
  });
});
