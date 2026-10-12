import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { startOutputBuffer } from "substrate-platform-ui";
import { useWorkspaceState } from "./WorkspaceContext";

/**
 * The Output panel's sources, like Visual Studio's "Show output from:" —
 * each its own event (see `OUTPUT_*` in `src-tauri/src/lib.rs`), buffered
 * from startup so switching to one shows everything it has said so far.
 */
export const OUTPUT_SOURCES = [
  { id: "build", label: "Build", event: "workflow-output" },
  { id: "game", label: "Game", event: "game-output" },
  { id: "debug", label: "Debug", event: "debug-output" },
  { id: "ide", label: "General", event: "ide-output" },
] as const;

export type OutputSource = (typeof OUTPUT_SOURCES)[number]["id"];

/** Event for an IDE-side message (`reportError`, the Project Explorer) — the "General" source. */
export const IDE_OUTPUT_EVENT = "ide-output";

function isOutputSource(value: unknown): value is OutputSource {
  return OUTPUT_SOURCES.some((s) => s.id === value);
}

// Module-level, like `outputBuffer`: the Output panel is only mounted while
// shown, but the source still has to follow a build or a launch meanwhile.
let current: OutputSource = "build";
const subscribers = new Set<() => void>();

export function setOutputSource(source: OutputSource): void {
  if (source === current) return;
  current = source;
  subscribers.forEach((notify) => notify());
}

function subscribe(notify: () => void) {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

/** The source the Output panel shows. */
export function useOutputSource(): OutputSource {
  return useSyncExternalStore(subscribe, () => current);
}

/**
 * Mounted once for the app's lifetime: starts buffering every source,
 * remembers the choice per project (`output.source`), and follows what's
 * happening — Build when a build or a run starts (a run builds the mod
 * first), Game once the launched game prints, Debug when an attach fails.
 */
export function OutputSourceSync() {
  const [stored, setStored] = useWorkspaceState<OutputSource>("output.source", "build", isOutputSource);

  useEffect(() => {
    for (const source of OUTPUT_SOURCES) startOutputBuffer(source.event);
  }, []);

  useEffect(() => setOutputSource(stored), [stored]);
  useEffect(() => subscribe(() => setStored(current)), [setStored]);

  useEffect(() => {
    // Only the first game line of a run switches over — after that the
    // user's own pick sticks.
    let awaitingGame = false;
    const unlistens = [
      listen("workflow-start", () => setOutputSource("build")),
      listen<{ stage: string }>("game-status", (e) => {
        if (e.payload.stage === "starting") {
          setOutputSource("build");
          awaitingGame = true;
        }
      }),
      listen("game-output", () => {
        if (!awaitingGame) return;
        awaitingGame = false;
        setOutputSource("game");
      }),
      listen("debug-attach-failed", () => setOutputSource("debug")),
    ];
    return () => {
      unlistens.forEach((p) => p.then((f) => f()));
    };
  }, []);

  return null;
}
