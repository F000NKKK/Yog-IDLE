// Live analysis: each open Yog-format file checked by the CLI as it's
// edited — its syntax and everything its format finds — the Error List and
// the editor's squiggles kept to the text as it is now, not as last saved.

import { useEffect, useRef } from "react";
import { setDiagnostics } from "substrate-platform-ui";
import { cli, problemDiagnostics, serviceTool, type ServiceProblem } from "../cli";
import { serveMethod } from "../data/yogIds.generated";
import { isDataFile } from "../files";
import type { FileTab } from "../openFiles/openFilesContext";

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
 * pauses), at once when it opens; a closed file's problems go.
 */
export function useLiveChecks(tabs: readonly FileTab[]): void {
  // The text last sent per file: an answer to an older one is dropped.
  const sent = useRef(new Map<string, string>());
  const timers = useRef(new Map<string, number>());
  useEffect(() => {
    const open = new Set<string>();
    for (const { path, content, textLoaded } of tabs) {
      if (!textLoaded || !isDataFile(path)) continue;
      open.add(path);
      if (sent.current.get(path) === content) continue;
      const first = !sent.current.has(path);
      sent.current.set(path, content);
      window.clearTimeout(timers.current.get(path));
      const run = () => {
        timers.current.delete(path);
        cli<{ problems: ServiceProblem[] }>(serveMethod.SOURCE_CHECK, { path, text: content }).then(
          ({ problems }) => sent.current.get(path) === content && show(path, problems),
          () => undefined,
        );
      };
      timers.current.set(path, window.setTimeout(run, first ? 0 : LIVE_CHECK_DELAY_MS));
    }
    for (const path of [...sent.current.keys()]) {
      if (open.has(path)) continue;
      sent.current.delete(path);
      window.clearTimeout(timers.current.get(path));
      timers.current.delete(path);
      show(path, []);
    }
  }, [tabs]);
}
