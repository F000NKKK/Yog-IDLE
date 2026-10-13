import { bench, describe } from "vitest";
import { yresText } from "../bench/fixtures";
import { parseYres, serializeYres } from "./yres";

const text = yresText(10_000);
const parsed = parseYres(text);
if (!parsed.ok) throw new Error(parsed.error);

describe("yres 10k entries", () => {
  bench("parseYres", () => {
    parseYres(text);
  });
  bench("serializeYres", () => {
    serializeYres(parsed.entries);
  });
});
