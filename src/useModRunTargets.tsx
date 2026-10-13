import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RunTarget } from "substrate-platform-ui";
import { EVENT, listenAll, listenTo } from "./events";

/**
 * A mod project's `yog.toml` `[run.<name>]` sections — plain named
 * script-invocation configs (like VS Code's `tasks.json`), not
 * loader/Minecraft-version settings. Shaped like `useWorkflowRunner` so
 * `RunToolbar` can treat either source the same way once it has picked one.
 */
export function useModRunTargets(projectRoot: string) {
  const [targets, setTargets] = useState<RunTarget[]>([]);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    invoke<RunTarget[]>("mod_run_targets", { projectRoot })
      .then(setTargets)
      .catch(() => setTargets([]));
  }, [projectRoot]);

  // Driven by the backend's own lifecycle events rather than only by who
  // called `run` — so a relaunch from anywhere (the toolbar's Restart goes
  // through `run` too, see `useDebugSession.restart`) can't leave this
  // stale: `game-status` "starting" always follows the previous session's
  // `workflow-exit` on the same event stream.
  useEffect(() => {
    return listenAll([
      listenTo(EVENT.workflowExit, () => setRunning(false)),
      listenTo(EVENT.gameStatus, (status) => {
        if (status.stage === "starting") setRunning(true);
      }),
    ]);
  }, []);

  const run = useCallback(
    (name: string, mode: string) => {
      setRunning(true);
      return invoke("mod_run", { projectRoot, name, mode }).catch((err) => {
        setRunning(false);
        throw err;
      });
    },
    [projectRoot]
  );

  return { targets, running, run };
}
