import { test } from "vitest";
import { yuiText } from "../bench/fixtures";
import { compute } from "./layout";
import { screenWidget } from "./layoutWidget";
import { parseYui, serializeYui, withAttrs, mapNode, type YuiDoc } from "./yui";
import { patchYui, scanYui } from "./yuiText";

const deep = yuiText(9, 4);
const wide = yuiText(2, 400);
const deepDoc = parseYui(deep);
const wideDoc = parseYui(wide);

/** A designer edit: one attribute changed on the last widget of the document. */
function edited(doc: YuiDoc): YuiDoc {
  let last = doc.root;
  while (last.children.length) last = last.children[last.children.length - 1];
  return { ...doc, root: mapNode(doc.root, last.uid, (n) => withAttrs(n, { text: "Edited", tooltip: "new" })) };
}
const deepNext = edited(deepDoc);
const wideNext = edited(wideDoc);

test("layout", async ({ bench }) => {
  await bench.compare(
    bench("compute deep (9 levels)", () => {
      compute(screenWidget(deepDoc.root, 480, 270), 480, 270);
    }),
    bench("compute wide (800 widgets)", () => {
      compute(screenWidget(wideDoc.root, 480, 270), 480, 270);
    }),
  );
});

test("yui text", async ({ bench }) => {
  await bench.compare(
    bench("parseYui wide", () => {
      parseYui(wide);
    }),
    bench("serializeYui wide", () => {
      serializeYui(wideDoc);
    }),
    bench("scanYui wide", () => {
      scanYui(wide);
    }),
    bench("patchYui wide", () => {
      patchYui(wide, wideDoc, wideNext);
    }),
    bench("patchYui deep", () => {
      patchYui(deep, deepDoc, deepNext);
    }),
  );
});
