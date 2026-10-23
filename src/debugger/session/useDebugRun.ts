// Running under the debugger: noting a run, stopping, restarting.

import { useCallback } from "react";
import { invokeCommand } from "substrate-platform-ui";
import { EVENT, listenTo } from "../../app/events";
import { yog } from "../../host.generated";
import type { DebugState } from "./useDebugState";

/** Running under the debugger: noting a run, stopping, restarting. */
export function useDebugRun(debugState: DebugState) {
  const { setAttaching, setDebugging, setError, setStopped, relaunchRef, setCanRestart } = debugState;
  const notifyRun = useCallback((relaunch: () => Promise<unknown>) => {
    relaunchRef.current = relaunch;
    setCanRestart(true);
  }, []);

  const stop = useCallback(() => {
    return invokeCommand(yog.debug.debugStop).finally(() => {
      setDebugging(false);
      setAttaching(false);
      setStopped(null);
    });
  }, []);

  const restart = useCallback(() => {
    const relaunch = relaunchRef.current;
    if (!relaunch) return;
    stop().finally(() => relaunch().catch((err) => setError(String(err))));
  }, [stop]);

  /**
   * Restart for a run that never became a game — a `workflow.toml` target
   * (or a mod run still building): cancel it, wait for its `workflow-exit`
   * so the relaunch doesn't race the old run's end, then start it again.
   */
  const restartWorkflow = useCallback(async () => {
    const relaunch = relaunchRef.current;
    if (!relaunch) return;
    let exit = () => {};
    const exited = new Promise<void>((resolve) => (exit = resolve));
    // Listening before cancelling, so the exit can't slip past.
    const unlisten = await listenTo(EVENT.workflowExit, () => exit());
    try {
      await invokeCommand(yog.run.workflowCancel);
      await exited;
      await relaunch();
    } catch (err) {
      setError(String(err));
    } finally {
      unlisten();
    }
  }, []);

  return { notifyRun, stop, restart, restartWorkflow };
}

/** What `useDebugRun` gives. */
export type DebugRun = ReturnType<typeof useDebugRun>;
