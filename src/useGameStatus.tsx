import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

const MAX_LINES = 500;

interface GameStatusEvent {
  stage: "starting" | "ready" | "exited";
  pid: number | null;
  mods: { id: string; name: string; version: string }[];
}

interface DebugStoppedEvent {
  reason: "breakpoint" | "signal" | "exited";
  stackTrace: unknown[];
}

/**
 * Drives the bottom status bar from whatever's actually happening with the
 * running game — `game-status`/`debug-attached`/`debug-attach-failed`/
 * `debug-stopped` (from the control-socket-backed run flow, see
 * `src-tauri/src/debugger.rs`) plus the existing `workflow-output`/
 * `workflow-exit` build/run log stream, so there's one place answering
 * "what is the IDE doing right now" instead of that being scattered
 * across whichever panel happens to be open.
 */
export function useGameStatus() {
  const [text, setText] = useState("Idle");
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const linesRef = useRef<string[]>([]);

  function pushLine(line: string) {
    linesRef.current = [...linesRef.current, line].slice(-MAX_LINES);
    setLines(linesRef.current);
  }

  useEffect(() => {
    const unlistens = [
      listen<string>("workflow-output", (e) => pushLine(e.payload)),
      listen("workflow-exit", () => {
        setText("Idle");
        setBusy(false);
      }),
      listen<GameStatusEvent>("game-status", (e) => {
        if (e.payload.stage === "starting") {
          setText("Starting…");
          setBusy(true);
        } else if (e.payload.stage === "exited") {
          setText("Idle");
          setBusy(false);
          pushLine("game process exited");
        } else {
          const modCount = e.payload.mods.length;
          setText(`Running — pid ${e.payload.pid} (${modCount} mod${modCount === 1 ? "" : "s"})`);
          setBusy(false);
          pushLine(`ready: pid ${e.payload.pid}, mods: ${e.payload.mods.map((m) => `${m.id}@${m.version}`).join(", ")}`);
        }
      }),
      listen("debug-attached", (e) => {
        setText(`Debugging — pid ${e.payload}`);
        setBusy(false);
      }),
      listen<string>("debug-attach-failed", (e) => {
        setText("Attach failed");
        setBusy(false);
        pushLine(`[error] ${e.payload}`);
      }),
      listen<DebugStoppedEvent>("debug-stopped", (e) => {
        if (e.payload.reason === "exited") {
          setText("Idle");
        } else if (e.payload.reason === "breakpoint") {
          setText("Debugging — stopped at breakpoint");
        } else {
          setText("Debugging — stopped");
        }
        setBusy(false);
      }),
    ];
    return () => {
      unlistens.forEach((p) => p.then((f) => f()));
    };
  }, []);

  return { text, busy, lines };
}
