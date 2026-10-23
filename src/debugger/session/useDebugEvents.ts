// The backend's debug events, kept in the state.

import { useEffect } from "react";
import { EVENT, listenAll, listenTo } from "../../app/events";
import type { DebugState } from "./useDebugState";

/** The backend's debug events, kept in the state. */
export function useDebugEvents(debugState: DebugState) {
  const { setAttaching, setDebugging, setError, setFailure, setStopped, setSelectedFrame, openSource } = debugState;
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
}

