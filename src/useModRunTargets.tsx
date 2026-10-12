import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RunTarget } from "substrate-platform-ui";

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
    const unlistens = [
      listen("workflow-exit", () => setRunning(false)),
      listen<{ stage: string }>("game-status", (e) => {
        if (e.payload.stage === "starting") setRunning(true);
      }),
    ];
    return () => {
      unlistens.forEach((p) => p.then((unlisten) => unlisten()));
    };
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
