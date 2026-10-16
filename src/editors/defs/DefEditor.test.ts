import { describe, expect, it } from "vitest";
import { DEF_DESIGNERS } from "./DefEditor";

describe(".ydef visual designer registry", () => {
  it("routes the supported kinds to their purpose-built editors", () => {
    expect(Object.keys(DEF_DESIGNERS).sort()).toEqual([
      "advancement",
      "effect",
      "loot_modifier",
      "loot_table",
      "tag",
    ]);
    expect(DEF_DESIGNERS.loot_table?.component).toBe(DEF_DESIGNERS.loot_modifier?.component);
  });
});
