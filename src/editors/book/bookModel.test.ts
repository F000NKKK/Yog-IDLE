import { describe, expect, it } from "vitest";
import { entriesOf, freshId, moved, newPage, readBook, withField, refId } from "./bookModel";

describe("bookModel", () => {
  it("reads a book and keeps unknown fields", async () => {
    const b = (await readBook(`{ "id": "m:g", "name": "@Book.t", "extra": 1, "entries": [{ "id": "e", "name": "E", "category": "c", "pages": [{ "type": "text", "text": "x" }] }] }`))!;
    expect(b.categories).toEqual([]);
    expect(b.entries[0].pages[0]).toEqual({ type: "text", text: "x" });
    expect(b.extra).toBe(1);
    expect(await readBook("[1]")).toBeNull();
    expect(await readBook("{")).toBeNull();
  });

  it("edits", () => {
    expect(freshId("m:e", ["m:e", "m:e_2"])).toBe("m:e_3");
    expect(moved([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(moved([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
    expect(withField({ a: 1, b: "x" }, "b", "")).toEqual({ a: 1 });
    expect(newPage("entity")).toEqual({ type: "entity", entity: "@entity:minecraft:pig" });
    expect(refId("@block:minecraft:furnace[facing=north]")).toBe("minecraft:furnace");
    expect(refId("minecraft:textures/x.png")).toBe("minecraft:textures/x.png");
  });

  it("lists a category's entries by their order", async () => {
    const b = (await readBook(`{ "id": "g", "name": "G", "entries": [
      { "id": "a", "name": "A", "category": "c", "priority": 2, "pages": [] },
      { "id": "b", "name": "B", "category": "x", "pages": [] },
      { "id": "c", "name": "C", "category": "c", "priority": 1, "pages": [] } ] }`))!;
    expect(entriesOf(b, "c").map((e) => e.entry.id)).toEqual(["c", "a"]);
  });
});
