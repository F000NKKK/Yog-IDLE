/**
 * The CLI the tests run: `YOG_CLI`, else the loader's debug build next to
 * this checkout (what the IDE is developed against), else `yog` on the PATH.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { program } from "../data/yogIds.generated";

const LOCAL_CLI = resolve(__dirname, "../../../Yog-Mod-Loader/rust/target/debug", program.CLI);

/** The CLI's path, or its name on the PATH. */
export const CLI = process.env.YOG_CLI ?? (existsSync(LOCAL_CLI) ? LOCAL_CLI : program.CLI);
