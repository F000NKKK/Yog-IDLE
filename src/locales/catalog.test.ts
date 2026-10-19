import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// One source per string: a key is translated once — here or in
// substrate-platform-ui's own catalog, never both, never twice here.

const KEY = /^\s*(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_]\w*))\s*:\s*(?:"|\{)/gm;
const PLURAL = new Set(["one", "few", "many", "other"]);

/** A Russian catalog's files: `ru.ts` and its areas' `ru.<area>.ts`. */
const CATALOG_FILE = /^ru(\.\w+)?\.ts$/;

function keysOf(dir: string): string[] {
  const folder = new URL(dir, import.meta.url);
  return readdirSync(folder)
    .filter((name) => CATALOG_FILE.test(name))
    .flatMap((name) => [...readFileSync(new URL(name, folder), "utf8").matchAll(KEY)])
    .map((m) => m[1] ?? m[2])
    .filter((k) => !PLURAL.has(k));
}

describe("ru catalog", () => {
  const own = keysOf("./");

  it("translates each string once", () => {
    const seen = new Set<string>();
    const twice = own.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
    expect(twice).toEqual([]);
  });

  it("leaves the platform's strings to the platform", () => {
    const platform = new Set(keysOf("../../node_modules/substrate-platform-ui/src/infra/i18n/locales/"));
    expect(own.filter((k) => platform.has(k))).toEqual([]);
  });
});
