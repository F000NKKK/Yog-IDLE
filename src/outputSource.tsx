import { useEffect } from "react";
import { onOutputSourceChange, outputSource, outputSources, registerOutputSources, setOutputSource, startOutputBuffer, useWorkspaceState } from "substrate-platform-ui";
import { EVENT, listenAll, listenTo } from "./events";

/** Yog IDLE's own Output sources, before the platform's (General, Source Control). */
const SOURCE = { build: "build", game: "game", debug: "debug" } as const;

registerOutputSources([
  { id: SOURCE.build, label: "Build", event: EVENT.buildOutput, emptyLabel: "Run a Build command to see output here." },
  { id: SOURCE.game, label: "Game", event: EVENT.gameOutput, emptyLabel: "Start the game to see its output here." },
  { id: SOURCE.debug, label: "Debug", event: EVENT.debugOutput, emptyLabel: "Debugger messages appear here." },
]);

function isOutputSource(value: unknown): value is string {
  return outputSources().some((s) => s.id === value);
}

/**
 * Mounted once for the app's lifetime: starts buffering every source,
 * remembers the choice per project (`output.source`), and follows what's
 * happening — Build when a build or a run starts (a run builds the mod
 * first), Game once the launched game prints, Debug when an attach fails.
 */
export function OutputSourceSync() {
  const [stored, setStored] = useWorkspaceState<string>("output.source", SOURCE.build, isOutputSource);

  useEffect(() => {
    for (const source of outputSources()) startOutputBuffer(source.event);
  }, []);

  useEffect(() => setOutputSource(stored), [stored]);
  useEffect(() => onOutputSourceChange(() => setStored(outputSource())), [setStored]);

  useEffect(() => {
    // Only the first game line of a run switches over — after that the
    // user's own pick sticks.
    let awaitingGame = false;
    return listenAll([
      listenTo(EVENT.workflowStart, () => setOutputSource(SOURCE.build)),
      listenTo(EVENT.gameStatus, (status) => {
        if (status.stage === "starting") {
          setOutputSource(SOURCE.build);
          awaitingGame = true;
        }
      }),
      listenTo(EVENT.gameOutput, () => {
        if (!awaitingGame) return;
        awaitingGame = false;
        setOutputSource(SOURCE.game);
      }),
      listenTo(EVENT.debugAttachFailed, () => setOutputSource(SOURCE.debug)),
      listenTo(EVENT.debugFailed, () => setOutputSource(SOURCE.debug)),
    ]);
  }, []);

  return null;
}
