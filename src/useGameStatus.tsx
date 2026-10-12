import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { t, tn, useLocale } from "substrate-platform-ui";

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
  useLocale();
  // A thunk, so the status re-translates when the language changes.
  const [text, setTextThunk] = useState<() => string>(() => () => t("Idle"));
  const setText = (status: () => string) => setTextThunk(() => status);
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
        setText(() => t("Building…"));
        setBusy(true);
      }),
      // A Build/Publish run carries a `WorkflowExit`; a game exiting fires
      // this too, with no payload.
      listen<WorkflowExitEvent | null>("workflow-exit", (e) => {
        if (e.payload?.cancelled) {
          setText(() => t("Build cancelled"));
          pushLine("build cancelled");
        } else if (e.payload && !e.payload.success) {
          setText(() => t("Build failed"));
          pushLine("[error] build failed");
        } else {
          setText(() => t("Idle"));
        }
        setBusy(false);
      }),
      listen<GameStatusEvent>("game-status", (e) => {
        if (e.payload.stage === "starting") {
          setStage("starting");
          setText(() => t("Starting…"));
          setBusy(true);
        } else if (e.payload.stage === "exited") {
          setStage("idle");
          setText(() => t("Idle"));
          setBusy(false);
          pushLine("game process exited");
        } else {
          setStage("ready");
          const modCount = e.payload.mods.length;
          const pid = e.payload.pid;
          setText(() => tn(modCount, "Running — pid {pid} ({count} mod)", "Running — pid {pid} ({count} mods)", { pid: String(pid), count: String(modCount) }));
          setBusy(false);
          pushLine(`ready: pid ${e.payload.pid}, mods: ${e.payload.mods.map((m) => `${m.id}@${m.version}`).join(", ")}`);
        }
      }),
      listen<HotReloadEvent>("hot-reload", (e) => {
        // The Output lines themselves arrive via `workflow-output` already.
        if (e.payload.stage === "done") {
          const { ok, modId } = e.payload;
          setText(() => (ok ? t("Hot reloaded {mod}", { mod: modId }) : t("Hot reload failed")));
          setBusy(false);
        } else {
          const building = e.payload.stage === "building";
          setText(() => (building ? t("Hot reload — building…") : t("Hot reload — reloading…")));
          setBusy(true);
        }
      }),
      listen("debug-attached", (e) => {
        const pid = String(e.payload);
        setText(() => t("Debugging — pid {pid}", { pid }));
        setBusy(false);
      }),
      listen<string>("debug-attach-failed", (e) => {
        setText(() => t("Attach failed"));
        setBusy(false);
        pushLine(`[error] ${e.payload}`);
      }),
      listen<string>("debug-failed", (e) => {
        setText(() => t("Debugger failed"));
        setBusy(false);
        pushLine(`[error] ${e.payload}`);
      }),
      listen<DebugStoppedEvent>("debug-stopped", (e) => {
        if (e.payload.reason === "exited") {
          setText(() => t("Idle"));
        } else if (e.payload.reason === "breakpoint") {
          setText(() => t("Debugging — stopped at breakpoint"));
        } else {
          setText(() => t("Debugging — stopped"));
        }
        setBusy(false);
      }),
    ];
    return () => {
      unlistens.forEach((p) => p.then((f) => f()));
    };
  }, []);

  return { text: text(), busy, lines, stage };
}
