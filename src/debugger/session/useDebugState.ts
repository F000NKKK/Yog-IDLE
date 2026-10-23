// The session's state: attaching, debugging, the stop, the selected frame and thread.

import { useCallback, useRef, useState } from "react";
import { openFile, t } from "substrate-platform-ui";
import type { DebugStackFrame, DebugStoppedEvent } from "../../app/events";
import { missingRustSrc } from "./debugModel";

/** The session's state: attaching, debugging, the stop, the selected frame and thread. */
export function useDebugState() {
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

  return { attaching, setAttaching, debugging, setDebugging, error, setError, failure, setFailure, errorKind, stopped, setStopped, selectedFrame, setSelectedFrame, relaunchRef, canRestart, setCanRestart, stoppedRef, resumingRef, openSource };
}

/** What `useDebugState` gives. */
export type DebugState = ReturnType<typeof useDebugState>;
