import { notify } from "substrate-platform-ui";
import { EVENT, emitTo, type OutputEvent } from "./events";

/**
 * Surfaces a failure the user should know about — as an `[error]` line in
 * Output (General unless the failure belongs to another source, so it's
 * still there after the toast fades) and as an error notification.
 */
export function reportError(message: string, output: OutputEvent = EVENT.ideOutput): void {
  emitTo(output, `[error] ${message}`);
  notify({ level: "error", message });
}
