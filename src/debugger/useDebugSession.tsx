import { useDebugState } from "./session/useDebugState";
import { useDebugEvents } from "./session/useDebugEvents";
import { useDebugRun } from "./session/useDebugRun";
import { useDebugStepping } from "./session/useDebugStepping";

export type { StepKind } from "./session/debugModel";

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
  const debugState = useDebugState();
  useDebugEvents(debugState);
  const debugRun = useDebugRun(debugState);
  const debugStepping = useDebugStepping(debugState);
  const { attaching, debugging, error, errorKind, stopped, selectedFrame, canRestart } = debugState;
  const { notifyRun, stop, restart, restartWorkflow } = debugRun;
  const { continue_, step, pause, selectFrame, executionLocation, selectThread, grantPtraceAccess } = debugStepping;
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
