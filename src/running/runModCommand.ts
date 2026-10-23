import { type HostCommand, invokeCommand, reportError, t } from "substrate-platform-ui";

/**
 * Runs a mod build command (`yog.run.modBuild`, `yog.run.modClean`) for the project at
 * `root` — one that's refused outright (the project isn't open anymore)
 * never starts a workflow, so this says why; `what` names it.
 */
export function runModCommand(command: HostCommand, root: string, what: string): Promise<void> {
  return invokeCommand<void>(command, { projectRoot: root }).catch((err) =>
    reportError(t("{action} failed to start: {error}", { action: what, error: String(err) })),
  );
}
