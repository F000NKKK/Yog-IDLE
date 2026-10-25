// Live analysis: each open Yog-format file checked by the CLI as it's
// edited — its syntax and everything its format finds — the Error List and
// the editor's squiggles kept to the text as it is now, not as last saved.

import { useEffect, useRef, useState } from "react";
import { setDiagnostics } from "substrate-platform-ui";
import { cli, problemDiagnostics, serviceTool, type ServiceProblem } from "../toolchain/cli";
import { serveMethod } from "../data/yogIds.generated";
import { isDataFile } from "../project/files";
import { EVENT, listenAll, listenTo } from "../app/events";
import type { FileTab } from "../openFiles/openFilesValue";

/** How long typing pauses before the file is checked again, ms. */
export const LIVE_CHECK_DELAY_MS = 300;

const checkSet = (path: string) => `check:${path}`;
/** The files whose text has problems now. */
const failing = new Set<string>();

/** Whether the file at `path`, as edited, has problems — what a check on save would find again. */
export function hasLiveProblems(path: string): boolean {
  return failing.has(path);
}

function show(path: string, problems: readonly ServiceProblem[]) {
  if (problems.length > 0) failing.add(path);
  else failing.delete(path);
  setDiagnostics(checkSet(path), problemDiagnostics(problems, serviceTool(serveMethod.SOURCE_CHECK), path));
}

/**
 * Checks every open Yog-format file whenever its text changes (once typing
 * pauses), at once when it opens or is read again from disk, and all of
 * them after a build (what they refer to may have changed); a closed
 * file's problems go.
 */
export function useLiveChecks(tabs: readonly FileTab[]): void {
  // What was last sent per file — its text, the read of it, the build
  // after which — an answer to an older one is dropped.
  const sent = useRef(new Map<string, string>());
  const timers = useRef(new Map<string, number>());
  const [builds, setBuilds] = useState(0);
  useEffect(() => {
    const built = () => setBuilds((n) => n + 1);
    return listenAll([listenTo(EVENT.workflowExit, built), listenTo(EVENT.hotReload, (e) => e.stage === "done" && built())]);
  }, []);
  useEffect(() => {
    const open = new Set<string>();
    for (const { path, content, textLoaded, contentVersion } of tabs) {
      if (!textLoaded || !isDataFile(path)) continue;
      open.add(path);
      const key = `${builds}:${contentVersion}:${content}`;
      const last = sent.current.get(path);
      if (last === key) continue;
      // Typed: checked once typing pauses; opened, read again or built: at once.
      const typed = last !== undefined && last.startsWith(`${builds}:${contentVersion}:`);
      sent.current.set(path, key);
      window.clearTimeout(timers.current.get(path));
      const run = () => {
        timers.current.delete(path);
        cli<{ problems: ServiceProblem[] }>(serveMethod.SOURCE_CHECK, { path, text: content }).then(
          ({ problems }) => sent.current.get(path) === key && show(path, problems),
          () => undefined,
        );
      };
      timers.current.set(path, window.setTimeout(run, typed ? LIVE_CHECK_DELAY_MS : 0));
    }
    for (const path of [...sent.current.keys()]) {
      if (open.has(path)) continue;
      sent.current.delete(path);
      window.clearTimeout(timers.current.get(path));
      timers.current.delete(path);
      show(path, []);
    }
  }, [tabs, builds]);
}
