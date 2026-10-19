import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RunTarget } from "substrate-platform-ui";
import { EVENT, listenAll, listenTo } from "./events";
import { useFilesChanged, useWatchedFolders } from "substrate-platform-ui";

/** What `mod_run_targets` gives: `yog run --list --json`, plus where to change it. */
export interface ModRunTargets {
  /** A loader (`group`) on a Minecraft version (`variant`), or one of the machine's own. */
  targets: RunTarget[];
  /** The folders they're read from: Yog's home, the loader SDK's versions. */
  sources: string[];
  /** The machine's local patch (`~/.yog/local.toml`). */
  localFile: string;
}

const NONE: ModRunTargets = { targets: [], sources: [], localFile: "" };

/**
 * The run targets a `yog-mod` project offers — not the project's: they
 * come from Yog's home (the loader SDK Yog Installer put there, the
 * machine's `local.toml`), the same for every mod. Kept fresh while those
 * files change. Shaped like `useWorkflowRunner` so `RunToolbar` can treat
 * either source the same way.
 */
export function useModRunTargets(projectRoot: string) {
  const [list, setList] = useState<ModRunTargets>(NONE);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const reload = useCallback(() => {
    invoke<ModRunTargets>("mod_run_targets", { projectRoot })
      .then((l) => {
        setList(l);
        setError(null);
      })
      .catch((err) => {
        setList(NONE);
        setError(String(err));
      });
  }, [projectRoot]);

  useEffect(reload, [reload]);
  useWatchedFolders("run-targets", list.sources);
  useFilesChanged((paths) => {
    if (paths.some((p) => list.sources.some((s) => p.startsWith(s)))) reload();
  });

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
    [projectRoot],
  );

  return { targets: list.targets, sources: list.sources, localFile: list.localFile, error, running, run };
}
