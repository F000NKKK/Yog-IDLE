import { reportError, t } from "substrate-platform-ui";
import { invokeYog } from "./invokeYog";

/**
 * Runs a `mod_*` build command (`mod_build`, `mod_clean`) for the project at
 * `root` — one that's refused outright (the project isn't open anymore)
 * never starts a workflow, so this says why; `what` names it.
 */
export function runModCommand(command: string, root: string, what: string): Promise<void> {
  return invokeYog<void>("run", command, { projectRoot: root }).catch((err) =>
    reportError(t("{action} failed to start: {error}", { action: what, error: String(err) })),
  );
}
