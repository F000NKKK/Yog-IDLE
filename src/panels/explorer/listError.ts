// A folder Project Explorer couldn't list, reported to Output.

import { t } from "substrate-platform-ui";
import { emitTo, EVENT } from "../../events";

/** A folder that failed to list stays unloaded in the tree (expanding it again retries) — say why in Output rather than only the devtools console. */
export function reportListError(error: unknown, path: string) {
  emitTo(EVENT.ideOutput, `[error] ${t("Couldn't list {path}: {error}", { path, error: String(error) })}`);
}
