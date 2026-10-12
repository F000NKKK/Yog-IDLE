import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openFile } from "./fileOpenBus";

export interface DebugStackFrame {
  id: number;
  name: string;
  file: string;
  line: number;
}

export interface DebugThread {
  id: number;
  name: string;
  /** Stopped and inspectable — the debugger is non-stop, so most threads keep running. */
  stopped: boolean;
}

export type StepKind = "over" | "into" | "out";

interface DebugStoppedEvent {
  reason: "breakpoint" | "step" | "pause" | "signal" | "exited";
  stackTrace: DebugStackFrame[];
  /** Every thread of the game; all are stopped while paused. */
  threads: DebugThread[];
  /** The thread `stackTrace`/`registers` describe. */
  thread: number;
  /** General-purpose registers of `thread`: `[name, hex value]`. */
  registers: [string, string][];
}

/**
 * Tracks the live state of whatever `RunBar`'s Start button most recently
 * launched (via `mod_run(root, name, mode)` — "debug" isn't a separately
 * triggered action anymore, it's just a run mode, see `RunToolbar.tsx`) —
 * `attaching`/`debugging`/`error`/`stopped` react to the `game-status`/
 * `debug-attached`/`debug-attach-failed`/`debug-stopped` events the Rust
 * side emits. `restart`/`stop` are still owned here since Stop/Restart
 * live in the toolbar, not next to the target picker.
 */
export function useDebugSession() {
  const [attaching, setAttaching] = useState(false);
  const [debugging, setDebugging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState<DebugStoppedEvent | null>(null);
  /** Index into `stopped.stackTrace` the editor's execution marker and the panel highlight follow. */
  const [selectedFrame, setSelectedFrame] = useState(0);
  const relaunchRef = useRef<(() => Promise<unknown>) | null>(null);
  const [canRestart, setCanRestart] = useState(false);

  useEffect(() => {
    const unlistenStarting = listen<{ stage: string }>("game-status", (event) => {
      if (event.payload.stage === "starting") {
        setAttaching(true);
        setError(null);
      } else if (event.payload.stage === "exited") {
        setAttaching(false);
        setDebugging(false);
        // However the session ended (crash included), drop the stop — the
        // editor's execution arrow and the panel go with it.
        setStopped(null);
      } else {
        setAttaching(false);
      }
    });
    const unlistenAttached = listen("debug-attached", () => {
      setAttaching(false);
      setDebugging(true);
      setError(null);
    });
    const unlistenFailed = listen<string>("debug-attach-failed", (event) => {
      setAttaching(false);
      setDebugging(false);
      setStopped(null);
      setError(event.payload);
    });
    const unlistenStopped = listen<DebugStoppedEvent>("debug-stopped", (event) => {
      setStopped(event.payload);
      setSelectedFrame(0);
      if (event.payload.reason === "exited") {
        setDebugging(false);
        return;
      }
      // Like any IDE: bring up where it stopped.
      const top = event.payload.stackTrace[0];
      if (top) openFile({ path: top.file, line: top.line });
    });
    return () => {
      unlistenStarting.then((f) => f());
      unlistenAttached.then((f) => f());
      unlistenFailed.then((f) => f());
      unlistenStopped.then((f) => f());
    };
  }, []);

  /**
   * Called by `RunToolbar` right when its Start button fires, with a
   * callback that repeats that exact launch through the same path (its
   * `useModRunTargets.run`), so `restart` keeps that hook's `running`
   * state honest instead of invoking `mod_run` behind its back.
   */
  const notifyRun = useCallback((relaunch: () => Promise<unknown>) => {
    relaunchRef.current = relaunch;
    setCanRestart(true);
  }, []);

  const stop = useCallback(() => {
    return invoke("debug_stop").finally(() => {
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
    const unlisten = await listen("workflow-exit", () => exit());
    try {
      await invoke("workflow_cancel");
      await exited;
      await relaunch();
    } catch (err) {
      setError(String(err));
    } finally {
      unlisten();
    }
  }, []);

  // Resuming invalidates the last stop: the panel shows "Running…" and the
  // editor drops its execution marker until the next `debug-stopped`.
  const continue_ = useCallback(() => {
    invoke("debug_continue")
      .then(() => setStopped(null))
      .catch((err) => setError(String(err)));
  }, []);

  const step = useCallback((kind: StepKind = "over") => {
    invoke("debug_step", { kind })
      .then(() => setStopped(null))
      .catch((err) => setError(String(err)));
  }, []);

  /** Break All — stops the running game wherever it is; the stop arrives as a `debug-stopped` with reason `"pause"`. */
  const pause = useCallback(() => {
    invoke("debug_pause").catch((err) => setError(String(err)));
  }, []);

  const selectFrame = useCallback(
    (index: number) => {
      const frame = stopped?.stackTrace[index];
      if (!frame) return;
      setSelectedFrame(index);
      openFile({ path: frame.file, line: frame.line });
    },
    [stopped],
  );

  /** Where the editor should draw the execution arrow: the selected frame's file/line while paused. */
  const executionLocation = stopped && stopped.reason !== "exited" ? (stopped.stackTrace[selectedFrame] ?? null) : null;

  const selectThread = useCallback((thread: number) => {
    invoke("debug_select_thread", { thread }).catch((err) => setError(String(err)));
  }, []);

  const grantPtraceAccess = useCallback(() => {
    return invoke("debug_grant_ptrace_capability");
  }, []);

  return { attaching, debugging, error, stopped, notifyRun, canRestart, stop, restart, restartWorkflow, continue_, step, pause, selectThread, selectedFrame, selectFrame, executionLocation, grantPtraceAccess };
}
