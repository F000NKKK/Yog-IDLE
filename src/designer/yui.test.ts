import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { yuiText } from "../bench/fixtures";
import { mapNode, orderedAttrs, parseYui, serializeYui, withAttrs, type YuiDoc } from "./yui";
import { formatYui, patchYui } from "./yuiText";

const sha = (s: string) => createHash("sha1").update(s).digest("hex");

/** Every widget's attributes reshuffled, a few replaced, one widget dropped: a busy designer edit. */
function edited(doc: YuiDoc): YuiDoc {
  let root = doc.root;
  const visit = (n: YuiDoc["root"], i: number): void => {
    if (i % 5 === 0) {
      const attrs = Object.fromEntries(Object.entries(n.attrs).reverse());
      root = mapNode(root, n.uid, (m) => withAttrs({ ...m, attrs }, { tooltip: `tip ${i}`, text: i % 2 ? undefined : "Changed" }));
    }
    n.children.forEach((c, j) => visit(c, i * 4 + j + 1));
  };
  visit(doc.root, 0);
  root = { ...root, children: root.children.slice(1).reverse() };
  return { ...doc, root };
}

describe("yui text", () => {
  // Recorded before attribute ranking and child matching went through maps.
  it("writes what it wrote before", () => {
    const out = [
      [3, 3],
      [6, 4],
      [2, 60],
    ].map(([depth, width]) => {
      const text = yuiText(depth, width);
      const doc = parseYui(text);
      const next = edited(doc);
      return [sha(serializeYui(next)), sha(patchYui(text, doc, next)), sha(formatYui(text))].join(" ");
    });
    expect(out).toMatchInlineSnapshot(`
      [
        "ce9e777b5efe8df46f5fbcebc11f5dc269f48d0c 8bda97843c07bc84368d44b37c8409613a927bdb e397fc81f220f9f43ae61d0bc41679bdb6324942",
        "d4a3bc42a9df8cecaed92168a789f8f1eab0abb6 512e5826efa90833c2ac18a198b3e4a81cbbe664 392cdfeb44232ee19fe9dbe11468a1d12ad3e427",
        "fcb1ef21fa17bcbe3e30808a597e4ffd698cd8c3 f21efe84527e65cbc1803a00852ad8fd2c8f45f9 60abc9bdffbeaad6493d5fe249f0c39b6f31b565",
      ]
    `);
  });

  it("orders known attributes first, unknown ones as written", () => {
    expect(orderedAttrs({ zeta: "1", text: "t", alpha: "2", "x:Name": "n", w: "3" }).map(([k]) => k)).toMatchInlineSnapshot(`
      [
        "w",
        "text",
        "zeta",
        "alpha",
        "x:Name",
      ]
    `);
  });
});
