import { useCallback, useEffect, useRef, useState } from "react";
import { type HostCommand, invokeCommand, openFile, t } from "substrate-platform-ui";
import { EVENT, listenAll, listenTo, type DebugStackFrame, type DebugStoppedEvent } from "./events";
import { yog } from "./host.generated";

export type StepKind = "over" | "into" | "out";

/**
 * Tracks the live state of whatever `RunBar`'s Start button most recently
 * launched (via `mod_run(root, name, mode)` — "debug" isn't a separately
 * triggered action anymore, it's just a run mode, see `RunToolbar.tsx`) —
 * `attaching`/`debugging`/`error`/`stopped` react to the `game-status`/
 * `debug-attached`/`debug-attach-failed`/`debug-stopped` events the Rust
 * side emits. `restart`/`stop` are still owned here since Stop/Restart
 * live in the toolbar, not next to the target picker.
 */
/**
 * `std` frames come as `/rustc/<commit>/library/...` when the backend found
 * no local `rust-src` to map them into — there's no file to open then.
 */
function missingRustSrc(path: string): boolean {
  return path.startsWith("/rustc/");
}

export function useDebugSession() {
  const [attaching, setAttaching] = useState(false);
  const [debugging, setDebugging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The last failure event: the attach failing, or an attached session's debugger giving up. */
  const [failure, setFailure] = useState<{ kind: "attach" | "session"; message: string } | null>(null);
  /** What `error` reports, if it's that failure (`null` for anything else). */
  const errorKind = failure && failure.message === error ? failure.kind : null;
  const [stopped, setStopped] = useState<DebugStoppedEvent | null>(null);
  /** Index into `stopped.stackTrace` the editor's execution marker and the panel highlight follow. */
  const [selectedFrame, setSelectedFrame] = useState(0);
  const relaunchRef = useRef<(() => Promise<unknown>) | null>(null);
  const [canRestart, setCanRestart] = useState(false);
  /** Mirrors `stopped` for the memoized step/continue callbacks. */
  const stoppedRef = useRef<DebugStoppedEvent | null>(null);
  stoppedRef.current = stopped;
  /** A Continue/Step was sent and the backend hasn't answered yet. */
  const resumingRef = useRef(false);

  const openSource = useCallback((frame: DebugStackFrame) => {
    if (missingRustSrc(frame.file)) {
      setError(t("Can't open {file}: Rust's standard library sources aren't installed — install rust-src (`rustup component add rust-src`).", { file: frame.file }));
      return;
    }
    openFile({ path: frame.file, line: frame.line });
  }, []);

  useEffect(() => {
    const onFailed = (kind: "attach" | "session") => (message: string) => {
      setAttaching(false);
      setDebugging(false);
      setStopped(null);
      setError(message);
      setFailure({ kind, message });
    };
    return listenAll([
      listenTo(EVENT.gameStatus, (status) => {
        if (status.stage === "starting") {
          setAttaching(true);
          setError(null);
          setFailure(null);
        } else if (status.stage === "exited") {
          setAttaching(false);
          setDebugging(false);
          // However the session ended (crash included), drop the stop — the
          // editor's execution arrow and the panel go with it.
          setStopped(null);
        } else {
          setAttaching(false);
        }
      }),
      listenTo(EVENT.debugAttached, () => {
        setAttaching(false);
        setDebugging(true);
        setError(null);
        setFailure(null);
      }),
      listenTo(EVENT.debugAttachFailed, onFailed("attach")),
      // The debugger gave up mid-session (the attach itself had worked).
      listenTo(EVENT.debugFailed, onFailed("session")),
      listenTo(EVENT.debugStopped, (stop) => {
        setStopped(stop);
        setSelectedFrame(0);
        if (stop.reason === "exited") {
          setDebugging(false);
          return;
        }
        // Like any IDE: bring up where it stopped.
        const top = stop.stackTrace[0];
        if (top) openSource(top);
      }),
    ]);
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

  // Resuming invalidates the last stop: the panel shows "Running…" and the
  // editor drops its execution marker until the next `debug-stopped`. The
  // stop is dropped *before* invoking — a quick step's `debug-stopped` can
  // arrive before the invoke resolves, and clearing it afterwards would
  // leave the UI "running" with the game paused. Only one resume at a time,
  // and only from a stop: a held-down F10 auto-repeats far faster than
  // steps complete (the backend rejects extras too).
  const resume = useCallback((command: HostCommand, args?: Record<string, unknown>) => {
    if (!stoppedRef.current || stoppedRef.current.reason === "exited" || resumingRef.current) return;
    resumingRef.current = true;
    stoppedRef.current = null;
    setStopped(null);
    invokeCommand(command, args)
      .catch((err) => setError(String(err)))
      .finally(() => {
        resumingRef.current = false;
      });
  }, []);

  const continue_ = useCallback(() => resume(yog.debug.debugContinue), [resume]);

  const step = useCallback((kind: StepKind = "over") => resume(yog.debug.debugStep, { kind }), [resume]);

  /** Break All — stops the running game wherever it is; the stop arrives as a `debug-stopped` with reason `"pause"`. */
  const pause = useCallback(() => {
    invokeCommand(yog.debug.debugPause).catch((err) => setError(String(err)));
  }, []);

  const selectFrame = useCallback(
    (index: number) => {
      const frame = stopped?.stackTrace[index];
      if (!frame) return;
      setSelectedFrame(index);
      openSource(frame);
    },
    [stopped, openSource],
  );

  /** Where the editor should draw the execution arrow: the selected frame's file/line while paused. */
  const executionLocation = stopped && stopped.reason !== "exited" ? (stopped.stackTrace[selectedFrame] ?? null) : null;

  const selectThread = useCallback((thread: number) => {
    invokeCommand(yog.debug.debugSelectThread, { thread }).catch((err) => setError(String(err)));
  }, []);

  const grantPtraceAccess = useCallback(() => {
    return invokeCommand(yog.debug.debugGrantPtraceCapability);
  }, []);

  return {
    attaching,
    debugging,
    error,
    errorKind,
    stopped,
    notifyRun,
    canRestart,
    stop,
    restart,
    restartWorkflow,
    continue_,
    step,
    pause,
    selectThread,
    selectedFrame,
    selectFrame,
    executionLocation,
    grantPtraceAccess,
  };
}
