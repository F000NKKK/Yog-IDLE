import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// One source per string: a key is translated once — here or in
// substrate-platform-ui's own catalog, never both, never twice here.

const KEY = /^\s*(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_]\w*))\s*:\s*(?:"|\{)/gm;
const PLURAL = new Set(["one", "few", "many", "other"]);

function keysOf(path: string): string[] {
  const text = readFileSync(new URL(path, import.meta.url), "utf8");
  return [...text.matchAll(KEY)].map((m) => m[1] ?? m[2]).filter((k) => !PLURAL.has(k));
}

describe("ru catalog", () => {
  const own = keysOf("./ru.ts");

  it("translates each string once", () => {
    const seen = new Set<string>();
    const twice = own.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
    expect(twice).toEqual([]);
  });

  it("leaves the platform's strings to the platform", () => {
    const platform = new Set(keysOf("../../node_modules/substrate-platform-ui/src/infra/i18n/locales/ru.ts"));
    expect(own.filter((k) => platform.has(k))).toEqual([]);
  });
});
