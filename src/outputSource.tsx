import { useEffect, useSyncExternalStore } from "react";
import { startOutputBuffer } from "substrate-platform-ui";
import { EVENT, listenAll, listenTo, type OutputEvent } from "./events";
import { useWorkspaceState } from "./WorkspaceContext";

/**
 * The Output panel's sources, like Visual Studio's "Show output from:" —
 * each its own event (see `OUTPUT_*` in `src-tauri/src/lib.rs`), buffered
 * from startup so switching to one shows everything it has said so far.
 */
export const OUTPUT_SOURCES = [
  { id: "build", label: "Build", event: EVENT.buildOutput },
  { id: "game", label: "Game", event: EVENT.gameOutput },
  { id: "debug", label: "Debug", event: EVENT.debugOutput },
  { id: "ide", label: "General", event: EVENT.ideOutput },
  { id: "git", label: "Source Control - Git", event: EVENT.gitOutput },
] as const satisfies readonly { id: string; label: string; event: OutputEvent }[];

export type OutputSource = (typeof OUTPUT_SOURCES)[number]["id"];

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
    return listenAll([
      listenTo(EVENT.workflowStart, () => setOutputSource("build")),
      listenTo(EVENT.gameStatus, (status) => {
        if (status.stage === "starting") {
          setOutputSource("build");
          awaitingGame = true;
        }
      }),
      listenTo(EVENT.gameOutput, () => {
        if (!awaitingGame) return;
        awaitingGame = false;
        setOutputSource("game");
      }),
      listenTo(EVENT.debugAttachFailed, () => setOutputSource("debug")),
      listenTo(EVENT.debugFailed, () => setOutputSource("debug")),
    ]);
  }, []);

  return null;
}
