import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EVENT, emitTo, listenTo } from "./events";

/**
 * The toolbar's Hot Reload action — `mod_hot_reload` rebuilds the project
 * and swaps the new `.yog` into the running game over its control socket
 * (see `debugger::hot_reload` on the Rust side). `busy` covers the whole
 * build + reload, ending on the `hot-reload` event's `"done"` stage; the
 * outcome itself is reported in Output and the status bar.
 */
export function useHotReload() {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const unlisten = listenTo(EVENT.hotReload, (reload) => setBusy(reload.stage !== "done"));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const trigger = useCallback((projectRoot: string) => {
    setBusy(true);
    invoke("mod_hot_reload", { projectRoot }).catch((err) => {
      setBusy(false);
      // Refused before anything started (not running, already busy, ...) —
      // no `hot-reload` event will follow, so report it here.
      emitTo(EVENT.buildOutput, `[error] hot reload: ${err}`);
    });
  }, []);

  return { busy, trigger };
}

