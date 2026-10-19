// Resuming, stepping, pausing, picking a frame or thread, ptrace access.

import { useCallback } from "react";
import { type HostCommand, invokeCommand } from "substrate-platform-ui";
import { yog } from "../../host.generated";
import type { StepKind } from "./debugModel";
import type { DebugState } from "./useDebugState";

/** Resuming, stepping, pausing, picking a frame or thread, ptrace access. */
export function useDebugStepping(debugState: DebugState) {
  const { setError, stopped, setStopped, selectedFrame, setSelectedFrame, stoppedRef, resumingRef, openSource } = debugState;
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

  return { resume, continue_, step, pause, selectFrame, executionLocation, selectThread, grantPtraceAccess };
}

/** What `useDebugStepping` gives. */
export type DebugStepping = ReturnType<typeof useDebugStepping>;
