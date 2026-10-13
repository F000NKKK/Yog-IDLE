import { bench, describe } from "vitest";
import { contentText } from "../bench/fixtures";
import { parseContent, serializeContent } from "./model";
import { blankImage, fill } from "./paint/pixels";

const text = contentText(400);
const parsed = parseContent(text);
if (!parsed.ok) throw new Error(parsed.error);

describe("content 400 elements", () => {
  bench("parseContent", () => {
    parseContent(text);
  });
  bench("serializeContent", () => {
    serializeContent(parsed.file);
  });
});

describe("paint 512²", () => {
  bench("flood fill", () => {
    fill(blankImage(512, 512), 10, 10, [255, 0, 0, 255], false);
  });
  bench("global fill", () => {
    fill(blankImage(512, 512), 10, 10, [255, 0, 0, 255], true);
  });
});
