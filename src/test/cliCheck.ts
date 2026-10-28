/**
 * Tests' way to the CLI's live check (`yog data check`, what `source.check`
 * says): a file an editor wrote, checked the way the IDE shows it. The CLI is
 * `YOG_CLI`, else the loader's debug build next to this checkout; without it
 * the tests that need it are skipped.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LOCAL_CLI = resolve(__dirname, "../../../Yog-Mod-Loader/rust/target/debug/yog");
const CLI = process.env.YOG_CLI ?? LOCAL_CLI;
const DIR = mkdtempSync(join(tmpdir(), "yog-idle-check-"));

/** Whether the CLI is there to check with. */
export const haveCli = existsSync(CLI);

/** What the live check finds in `value` written as a file named `name` (`x.yblock`): one problem a line. */
export function cliProblems(name: string, value: unknown): string[] {
  const path = join(DIR, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  const run = spawnSync(CLI, ["data", "check", path], { encoding: "utf8" });
  if (run.error) throw run.error;
  return run.stdout.split("\n").filter((line) => line.trim() !== "");
}
