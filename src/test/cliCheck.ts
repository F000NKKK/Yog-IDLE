/**
 * Tests' way to the CLI's live check (`yog data check`, what `source.check`
 * says): a file an editor wrote, checked the way the IDE shows it. The CLI is
 * `YOG_CLI`, else the loader's debug build next to this checkout; without it
 * the tests that need it are skipped, unless `YOG_REQUIRE_CLI` asks for it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LOCAL_CLI = resolve(__dirname, "../../../Yog-Mod-Loader/rust/target/debug/yog");
const CLI = process.env.YOG_CLI ?? LOCAL_CLI;
const DIR = mkdtempSync(join(tmpdir(), "yog-idle-check-"));

/** Whether the CLI is there to check with; CI (`YOG_REQUIRE_CLI`) fails without it. */
export const haveCli = existsSync(CLI);
if (!haveCli && process.env.YOG_REQUIRE_CLI) throw new Error(`no CLI at ${CLI} (YOG_REQUIRE_CLI is set)`);

/** What the live check finds in `value` written as a file named `name` (`x.yblock`): one problem a line. */
export function cliProblems(name: string, value: unknown): string[] {
  const path = join(DIR, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  const run = spawnSync(CLI, ["data", "check", path], { encoding: "utf8" });
  if (run.error) throw run.error;
  return run.stdout.split("\n").filter((line) => line.trim() !== "");
}

/** The CLI's output for `args`, which must succeed. */
function cliOut(args: string[]): string {
  const run = spawnSync(CLI, args, { encoding: "utf8" });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`yog ${args.join(" ")}: ${run.stderr}`);
  return run.stdout;
}

/** Format `ext`'s shape (`yog schema`), as the IDE's editors get it. */
export const cliShape = (ext: string): unknown => JSON.parse(cliOut(["schema", ext]));

/** The file at `path` (binary or text) as a value (`yog data text`). */
export const cliValue = (path: string): unknown => JSON.parse(cliOut(["data", "text", path]));
