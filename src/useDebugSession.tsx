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
 * Owns the "Start Debugging"/"Stop Debugging" lifecycle — thin wrapper
 * around the `debug_*` Tauri commands and their `debug-attached`/
 * `debug-attach-failed`/`debug-stopped` events (see `src-tauri/src/
 * debugger.rs`). Shaped like `useModRunTargets`/`useWorkflowRunner` so the
 * toolbar/menu can treat it the same way once attached.
 */
export function useDebugSession() {
  const [attaching, setAttaching] = useState(false);
  const [debugging, setDebugging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState<DebugStoppedEvent | null>(null);
  const lastRef = useRef<{ projectRoot: string; configName: string } | null>(null);

  useEffect(() => {
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
      unlistenAttached.then((f) => f());
      unlistenFailed.then((f) => f());
      unlistenStopped.then((f) => f());
    };
  }, []);

  const start = useCallback((projectRoot: string, configName: string) => {
    setAttaching(true);
    setError(null);
    invoke("debug_start", { projectRoot, configName }).catch((err) => {
      setAttaching(false);
      setError(String(err));
    });
  }, []);

  const stop = useCallback(() => {
    invoke("debug_stop").finally(() => {
      setDebugging(false);
      setStopped(null);
    });
  }, []);

  const continue_ = useCallback(() => {
    invoke("debug_continue").catch((err) => setError(String(err)));
  }, []);

  const step = useCallback(() => {
    invoke("debug_step").catch((err) => setError(String(err)));
  }, []);

  return { attaching, debugging, error, stopped, start, stop, continue_, step };
}
