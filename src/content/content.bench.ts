import { bench, describe } from "vitest";
import { blankImage, fill } from "./paint/pixels";

describe("paint 512²", () => {
  bench("flood fill", () => {
    fill(blankImage(512, 512), 10, 10, [255, 0, 0, 255], false);
  });
  bench("global fill", () => {
    fill(blankImage(512, 512), 10, 10, [255, 0, 0, 255], true);
  });
});
