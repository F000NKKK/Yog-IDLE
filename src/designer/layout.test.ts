import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { yuiText } from "../bench/fixtures";
import { compute, screenWidget } from "./layout";
import { parseYui } from "./yui";

const CASES: [depth: number, width: number, w: number, h: number][] = [
  [3, 3, 176, 166],
  [5, 4, 480, 270],
  [9, 4, 480, 270],
  [2, 40, 320, 240],
  [4, 6, 90, 60],
];

/** Digest of the whole layout tree, so a regression in any rect or grid line shows up. */
function digest(depth: number, width: number, w: number, h: number): string {
  const doc = parseYui(yuiText(depth, width));
  const tree = compute(screenWidget(doc.root, w, h), w, h);
  return createHash("sha1").update(JSON.stringify(tree)).digest("hex");
}

describe("compute", () => {
  // The digests were recorded before measurements were memoized: the memo must
  // not change a single rect.
  it("lays out exactly as the unmemoized pass did", () => {
    expect(CASES.map((c) => `${c.join("x")} ${digest(...c)}`)).toMatchInlineSnapshot(`
      [
        "3x3x176x166 6564bd050da9d81696d227a74bc4e1a774954b75",
        "5x4x480x270 3c282b88ad546f493450bff2e3e63352ec82ebdd",
        "9x4x480x270 9a99d8a1c82e98b22e8663436c40d92eaf5bb630",
        "2x40x320x240 4ddcf4ae2edb31f60df073d9bf6c3d4bdf512fad",
        "4x6x90x60 469e992a1f85a0939ffe860a01bc9364ff2cff9d",
      ]
    `);
  });
});
