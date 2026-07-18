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

  useEffect(() => {
    const unlistenPromise = listen("workflow-exit", () => setRunning(false));
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const run = useCallback(
    (name: string) => {
      setRunning(true);
      return invoke("mod_run", { projectRoot, name }).catch((err) => {
        setRunning(false);
        throw err;
      });
    },
    [projectRoot]
  );

  return { targets, running, run };
}
