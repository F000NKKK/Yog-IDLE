import { describe, expect, it } from "vitest";
import { bodyId, bodyRef, eyeHeight, kindOf, moved, pushable, type EntityFile } from "./yentity";
import { editData, readFile } from "../test/data";
import { prefetchTyped } from "../data/typed";
import { NO_REFS, refProblem, type RefChoices } from "../data/contentRefs";

const FILE = `// A wisp.
{
  "kind": "mob",
  "width": 0.5, // blocks
  "height": 0.6,
  "goals": ["float", "wander"]
}
`;

const edit = (text: string, change: (f: EntityFile) => void) => editData<EntityFile>(text, change);

describe("yentity", () => {
  it("reads the kind and the format's defaults", async () => {
    expect(kindOf(await readFile<EntityFile>(FILE))).toBe("mob");
    expect(kindOf({})).toBe("object");
    expect(eyeHeight({ height: 2 })).toBeCloseTo(1.7);
    expect(pushable({ kind: "living" })).toBe(true);
    expect(pushable({ kind: "hanging" })).toBe(false);
    await expect(readFile("[1]")).rejects.toThrow();
  });

  it("writes edits in place, comments kept", async () => {
    const out = await edit(FILE, (f) => {
      f.width = 0.75;
      f.spawn_egg = [0xff0000, 0x00ff00];
    });
    expect(out).toContain('"width": 0.75, // blocks');
    expect(out).toContain("// A wisp.");
    expect(out).toContain('"spawn_egg": [16711680, 65280]');
    const reordered = await readFile<EntityFile>(await edit(FILE, (f) => (f.goals = moved(f.goals!, 1, 0))));
    expect(reordered.goals).toEqual(["wander", "float"]);
  });

  it("names body files as the build does", () => {
    expect(bodyRef("mymod:body/wisp", "mymod")).toBe("body/wisp");
    expect(bodyRef("other:body/x", "mymod")).toBe("other:body/x");
    expect(bodyId("body/wisp", "mymod")).toBe("mymod:body/wisp");
  });

  it("checks references", async () => {
    await prefetchTyped(["@entity:mymod:wisp", "@entity:create:seat", "@entity:minecraft:cow", "@item:minecraft:pig", "@tag:entity:minecraft:raiders", "@entity:other:x"]);
    const c: RefChoices = { own: [{ id: "mymod:wisp", file: "" }], external: ["create:seat"], game: ["minecraft:pig"] };
    expect(refProblem("@entity:mymod:wisp", "entity", c)).toBeNull();
    expect(refProblem("@entity:create:seat", "entity", c)).toBeNull();
    expect(refProblem("@entity:minecraft:cow", "entity", c)).toEqual({ t: "unknown", id: "minecraft:cow" });
    expect(refProblem("@item:minecraft:pig", "entity", c)).toEqual({ t: "syntax", kind: "entity" });
    expect(refProblem("@tag:entity:minecraft:raiders", "entity", c, true)).toBeNull();
    // Without a client jar the game's ids can't be checked; nothing is known before the list arrives.
    expect(refProblem("@entity:minecraft:cow", "entity", { ...c, game: [] })).toBeNull();
    expect(refProblem("@entity:other:x", "entity", NO_REFS)).toBeNull();
  });
});
