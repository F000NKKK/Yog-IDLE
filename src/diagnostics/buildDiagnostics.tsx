import { useEffect } from "react";
import { addDiagnostics, clearDiagnostics, setDiagnostics, type Diagnostic } from "substrate-platform-ui";
import { unframe } from "../data/binary";
import type { Diagnostic as YogDiagnostic } from "../data/yogDataBinary.generated";
import { program } from "../data/yogIds.generated";
import { EVENT, listenAll, listenTo } from "../events";
import { hasLiveProblems } from "./liveCheck";
import { yogDiagnostic } from "./yogDiagnostic";

/** Error List set holding the last build's diagnostics. */
const BUILD_SET = "build";
/** Error List set of one file's on-save check. */
const liveSet = (path: string) => `live:${path}`;
/** Coalesces a burst of a build's records into one Error List update. */
const FLUSH_DELAY_MS = 100;

/** One diagnostic per place and message. */
const keyOf = (d: Diagnostic) => [d.severity, d.code, d.file, d.line, d.column, d.message].join("\u0000");

/**
 * Feeds the Error List from builds: every `yog` run the IDE starts (Build,
 * a run's build, a hot reload's) reports what it finds as records
 * (`build-diagnostic`), and a new one replaces the "build" set. Mounted
 * once, beside the Output panel's own sync.
 */
export function BuildDiagnosticsSync({ root, project }: { root: string | null; project?: string }) {
  useEffect(() => {
    // Another project (or none): the previous one's diagnostics don't apply.
    setDiagnostics(BUILD_SET, []);
    clearLiveDiagnostics();
    let buildRoot = root;
    let seen = new Set<string>();
    let pending: Diagnostic[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      addDiagnostics(BUILD_SET, pending);
      pending = [];
    };
    const start = (at: string | null) => {
      clearTimeout(timer);
      timer = undefined;
      pending = [];
      seen = new Set();
      setDiagnostics(BUILD_SET, []);
      buildRoot = at ?? root;
    };
    const found = (frame: number[]) => {
      const record = unframe(Uint8Array.from(frame)) as unknown as YogDiagnostic;
      const d = yogDiagnostic(record, { tool: program.CLI, origin: "build", root: buildRoot ?? undefined, project });
      const key = keyOf(d);
      if (seen.has(key)) return;
      seen.add(key);
      pending.push(d);
      timer ??= setTimeout(flush, FLUSH_DELAY_MS);
    };
    return listenAll([
      listenTo(EVENT.workflowStart, (payload) => start(payload?.root ?? null)),
      listenTo(EVENT.hotReload, (e) => e.stage === "building" && start(null)),
      // A run's build fires no workflow-start: the game starting is its start.
      listenTo(EVENT.gameStatus, (e) => e.stage === "starting" && start(null)),
      listenTo(EVENT.buildDiagnostic, found),
    ]);
  }, [root, project]);
  return null;
}

/**
 * A saved `.yui`/`.yres`/`.yblock`/`.yitem` file's check (see
 * `regenerateScreen`): what yog found in the project at `root`. Replaces
 * that file's live set.
 */
export function setSavedFileDiagnostics(path: string, root: string, problems: readonly YogDiagnostic[]): void {
  // Its problems as edited are the live check's; the save's would repeat them.
  if (hasLiveProblems(path)) return setDiagnostics(liveSet(path), []);
  // A failure that names no file is still about this one.
  const place = { tool: program.CLI, origin: "live" as const, root, file: path };
  setDiagnostics(liveSet(path), problems.map((d) => yogDiagnostic(d, place)));
}

/** Drops every on-save check — the project closed. */
export function clearLiveDiagnostics(): void {
  clearDiagnostics({ origin: "live" });
}
