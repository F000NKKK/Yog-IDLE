import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { StatusBar, t, tn, useLocale } from "substrate-platform-ui";
import { EVENT, listenAll, listenTo } from "./events";

const MAX_LINES = 500;

/** Where the launched game is in its lifecycle — `"idle"` when nothing is running. */
export type GameStage = "idle" | "starting" | "ready";

// The status bar's detail lines live outside React: they arrive with every
// Output line, and only the status bar itself needs to re-render for them.
let lines: string[] = [];
const lineListeners = new Set<() => void>();

function pushLine(line: string) {
  lines = [...lines, line].slice(-MAX_LINES);
  lineListeners.forEach((notify) => notify());
}

function subscribeLines(notify: () => void): () => void {
  lineListeners.add(notify);
  return () => lineListeners.delete(notify);
}

/** The platform status bar showing `useGameStatus`'s text, with its recent lines as the detail. */
export function GameStatusBar({ text, busy, trailing }: { text: string; busy: boolean; trailing?: ReactNode }) {
  const detail = useSyncExternalStore(subscribeLines, () => lines);
  return <StatusBar text={text} busy={busy} detail={detail} trailing={trailing} />;
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

  useEffect(() => {
    const sources = [EVENT.buildOutput, EVENT.gameOutput, EVENT.debugOutput, EVENT.ideOutput] as const;
    return listenAll([
      ...sources.map((source) => listenTo(source, pushLine)),
      listenTo(EVENT.workflowStart, () => {
        setText(() => t("Building…"));
        setBusy(true);
      }),
      // A Build/Publish run carries a `WorkflowExit`; a game exiting fires
      // this too, with no payload.
      listenTo(EVENT.workflowExit, (exit) => {
        if (exit?.cancelled) {
          setText(() => t("Build cancelled"));
          pushLine("build cancelled");
        } else if (exit && !exit.success) {
          setText(() => t("Build failed"));
          pushLine("[error] build failed");
        } else {
          setText(() => t("Idle"));
        }
        setBusy(false);
      }),
      listenTo(EVENT.gameStatus, (status) => {
        if (status.stage === "starting") {
          setStage("starting");
          setText(() => t("Starting…"));
          setBusy(true);
        } else if (status.stage === "exited") {
          setStage("idle");
          setText(() => t("Idle"));
          setBusy(false);
          pushLine("game process exited");
        } else {
          setStage("ready");
          const modCount = status.mods.length;
          const pid = status.pid;
          setText(() => tn(modCount, "Running — pid {pid} ({count} mod)", "Running — pid {pid} ({count} mods)", { pid: String(pid), count: String(modCount) }));
          setBusy(false);
          pushLine(`ready: pid ${status.pid}, mods: ${status.mods.map((m) => `${m.id}@${m.version}`).join(", ")}`);
        }
      }),
      listenTo(EVENT.hotReload, (reload) => {
        // The Output lines themselves arrive via `workflow-output` already.
        if (reload.stage === "done") {
          const { ok, modId } = reload;
          setText(() => (ok ? t("Hot reloaded {mod}", { mod: modId }) : t("Hot reload failed")));
          setBusy(false);
        } else {
          const building = reload.stage === "building";
          setText(() => (building ? t("Hot reload — building…") : t("Hot reload — reloading…")));
          setBusy(true);
        }
      }),
      listenTo(EVENT.debugAttached, (attached) => {
        const pid = String(attached);
        setText(() => t("Debugging — pid {pid}", { pid }));
        setBusy(false);
      }),
      listenTo(EVENT.debugAttachFailed, (error) => {
        setText(() => t("Attach failed"));
        setBusy(false);
        pushLine(`[error] ${error}`);
      }),
      listenTo(EVENT.debugFailed, (error) => {
        setText(() => t("Debugger failed"));
        setBusy(false);
        pushLine(`[error] ${error}`);
      }),
      listenTo(EVENT.debugStopped, (stop) => {
        if (stop.reason === "exited") {
          setText(() => t("Idle"));
        } else if (stop.reason === "breakpoint") {
          setText(() => t("Debugging — stopped at breakpoint"));
        } else {
          setText(() => t("Debugging — stopped"));
        }
        setBusy(false);
      }),
    ]);
  }, []);

  return { text: text(), busy, stage };
}
