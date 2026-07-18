import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface DebugStackFrame {
  id: number;
  name: string;
  file: string;
  line: number;
}

interface DebugStoppedEvent {
  reason: "breakpoint" | "signal" | "exited";
  stackTrace: DebugStackFrame[];
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
  const lastRef = useRef<{ projectRoot: string; name: string; mode: string } | null>(null);

  useEffect(() => {
    const unlistenStarting = listen<{ stage: string }>("game-status", (event) => {
      if (event.payload.stage === "starting") {
        setAttaching(true);
        setError(null);
      } else if (event.payload.stage === "exited") {
        setAttaching(false);
        setDebugging(false);
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
      setError(event.payload);
    });
    const unlistenStopped = listen<DebugStoppedEvent>("debug-stopped", (event) => {
      setStopped(event.payload);
      if (event.payload.reason === "exited") setDebugging(false);
    });
    return () => {
      unlistenStarting.then((f) => f());
      unlistenAttached.then((f) => f());
      unlistenFailed.then((f) => f());
      unlistenStopped.then((f) => f());
    };
  }, []);

  /** Called by `RunToolbar` right when its Start button fires `mod_run`, so `restart` knows what to relaunch. */
  const notifyRun = useCallback((projectRoot: string, name: string, mode: string) => {
    lastRef.current = { projectRoot, name, mode };
  }, []);

  const stop = useCallback(() => {
    return invoke("debug_stop").finally(() => {
      setDebugging(false);
      setAttaching(false);
      setStopped(null);
    });
  }, []);

  const restart = useCallback(() => {
    const last = lastRef.current;
    if (!last) return;
    stop().finally(() => invoke("mod_run", last).catch((err) => setError(String(err))));
  }, [stop]);

  const continue_ = useCallback(() => {
    invoke("debug_continue").catch((err) => setError(String(err)));
  }, []);

  const step = useCallback(() => {
    invoke("debug_step").catch((err) => setError(String(err)));
  }, []);

  const grantPtraceAccess = useCallback(() => {
    return invoke("debug_grant_ptrace_capability");
  }, []);

  return { attaching, debugging, error, stopped, notifyRun, stop, restart, continue_, step, grantPtraceAccess };
}
