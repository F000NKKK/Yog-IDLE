import { test } from "vitest";
import { blankImage, fill } from "./paint/pixels";

test("paint 512²", async ({ bench }) => {
  await bench.compare(
    bench("flood fill", () => {
      fill(blankImage(512, 512), 10, 10, [255, 0, 0, 255], false);
    }),
    bench("global fill", () => {
      fill(blankImage(512, 512), 10, 10, [255, 0, 0, 255], true);
    }),
  );
});
