import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

const MAX_LINES = 500;

interface GameStatusEvent {
  stage: "starting" | "ready" | "exited";
  pid: number | null;
  mods: { id: string; name: string; version: string }[];
}

export interface HotReloadEvent {
  stage: "building" | "reloading" | "done";
  modId: string;
  ok: boolean | null;
  message: string;
}

/** `workflow-exit`'s payload when a Build/Publish run (not a game) ended. */
export interface WorkflowExitEvent {
  success: boolean;
  cancelled: boolean;
}

/** Where the launched game is in its lifecycle — `"idle"` when nothing is running. */
export type GameStage = "idle" | "starting" | "ready";

interface DebugStoppedEvent {
  reason: "breakpoint" | "signal" | "exited";
  stackTrace: unknown[];
}

/**
 * Drives the bottom status bar from whatever's actually happening with the
 * running game — `game-status`/`debug-attached`/`debug-attach-failed`/
 * `debug-stopped`/`hot-reload` (from the control-socket-backed run flow, see
 * `src-tauri/src/debugger.rs`) plus every Output source's lines and
 * `workflow-exit`, so there's one place answering
 * "what is the IDE doing right now" instead of that being scattered
 * across whichever panel happens to be open.
 */
export function useGameStatus() {
  const [text, setText] = useState("Idle");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<GameStage>("idle");
  const [lines, setLines] = useState<string[]>([]);
  const linesRef = useRef<string[]>([]);

  function pushLine(line: string) {
    linesRef.current = [...linesRef.current, line].slice(-MAX_LINES);
    setLines(linesRef.current);
  }

  useEffect(() => {
    const unlistens = [
      ...["workflow-output", "game-output", "debug-output", "ide-output"].map((source) =>
        listen<string>(source, (e) => pushLine(e.payload)),
      ),
      listen("workflow-start", () => {
        setText("Building…");
        setBusy(true);
      }),
      // A Build/Publish run carries a `WorkflowExit`; a game exiting fires
      // this too, with no payload.
      listen<WorkflowExitEvent | null>("workflow-exit", (e) => {
        if (e.payload?.cancelled) {
          setText("Build cancelled");
          pushLine("build cancelled");
        } else if (e.payload && !e.payload.success) {
          setText("Build failed");
          pushLine("[error] build failed");
        } else {
          setText("Idle");
        }
        setBusy(false);
      }),
      listen<GameStatusEvent>("game-status", (e) => {
        if (e.payload.stage === "starting") {
          setStage("starting");
          setText("Starting…");
          setBusy(true);
        } else if (e.payload.stage === "exited") {
          setStage("idle");
          setText("Idle");
          setBusy(false);
          pushLine("game process exited");
        } else {
          setStage("ready");
          const modCount = e.payload.mods.length;
          setText(`Running — pid ${e.payload.pid} (${modCount} mod${modCount === 1 ? "" : "s"})`);
          setBusy(false);
          pushLine(`ready: pid ${e.payload.pid}, mods: ${e.payload.mods.map((m) => `${m.id}@${m.version}`).join(", ")}`);
        }
      }),
      listen<HotReloadEvent>("hot-reload", (e) => {
        // The Output lines themselves arrive via `workflow-output` already.
        if (e.payload.stage === "done") {
          setText(e.payload.ok ? `Hot reloaded ${e.payload.modId}` : "Hot reload failed");
          setBusy(false);
        } else {
          setText(e.payload.stage === "building" ? "Hot reload — building…" : "Hot reload — reloading…");
          setBusy(true);
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

  return { text, busy, lines, stage };
}
