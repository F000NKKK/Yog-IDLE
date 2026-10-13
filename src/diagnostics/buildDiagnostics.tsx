import { useEffect } from "react";
import { addDiagnostics, clearDiagnostics, createRustcParser, setDiagnostics, type Diagnostic, type RustcParser } from "substrate-platform-ui";
import { EVENT, listenAll, listenTo } from "../events";
import { createYogParser, resolveFrom, stripLevelTag } from "./yogOutput";

/** Error List set holding the last build's diagnostics. */
const BUILD_SET = "build";
/** Error List set of one file's on-save check. */
const liveSet = (path: string) => `live:${path}`;
/** The generated crate cargo builds in — rustc prints paths relative to it. */
const BUILD_DIR = ".yog-build";
/** Coalesces a burst of build output into one Error List update. */
const FLUSH_DELAY_MS = 100;
/** `yog run`'s line between its build and the game's own output. */
const LAUNCHED = "==> launched pid ";

/** What a terminal would show of a line cargo redraws with `\r` (its progress bar, then the diagnostic). */
const lastSegment = (line: string) => line.slice(line.lastIndexOf("\r") + 1);

/** One diagnostic per place and message — `yog build` compiles the same code once per platform. */
const keyOf = (d: Diagnostic) => [d.severity, d.code, d.file, d.line, d.column, d.message].join("\u0000");

interface BuildParsers {
  rustc: RustcParser;
  yog: ReturnType<typeof createYogParser>;
}

function parsersFor(root: string, project: string | undefined): BuildParsers {
  return {
    rustc: createRustcParser({ resolvePath: (p) => resolveFrom(`${root}/${BUILD_DIR}`, p) }),
    yog: createYogParser({ root, project }),
  };
}

/**
 * Feeds the Error List from builds: every `yog build` (Build, a run's
 * build, a hot reload's) replaces the "build" set with what rustc and
 * yog-cli report in the Build output. A run's build fires no
 * `workflow-start`, so Build output arriving with no build open starts
 * one; it ends at the game's launch or exit. Mounted once, beside the
 * Output panel's own sync.
 */
export function BuildDiagnosticsSync({ root, project }: { root: string | null; project?: string }) {
  useEffect(() => {
    // Another project (or none): the previous one's diagnostics don't apply.
    setDiagnostics(BUILD_SET, []);
    clearLiveDiagnostics();
    let parsers: BuildParsers | null = null;
    let seen = new Set<string>();
    let pending: Diagnostic[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      addDiagnostics(BUILD_SET, pending);
      pending = [];
    };
    const queue = (items: Diagnostic[]) => {
      for (const d of items) {
        const key = keyOf(d);
        if (seen.has(key)) continue;
        seen.add(key);
        pending.push(d);
      }
      if (pending.length > 0) timer ??= setTimeout(flush, FLUSH_DELAY_MS);
    };
    const start = (buildRoot: string | null) => {
      clearTimeout(timer);
      timer = undefined;
      pending = [];
      seen = new Set();
      setDiagnostics(BUILD_SET, []);
      const at = buildRoot ?? root;
      parsers = at ? parsersFor(at, project) : null;
    };
    const finish = () => {
      if (!parsers) return;
      queue(parsers.rustc.flush());
      parsers = null;
      clearTimeout(timer);
      flush();
    };
    return listenAll([
      listenTo(EVENT.workflowStart, (payload) => start(payload?.root ?? null)),
      listenTo(EVENT.hotReload, (e) => {
        if (e.stage === "building") start(null);
        else finish();
      }),
      listenTo(EVENT.buildOutput, (raw) => {
        const line = lastSegment(raw);
        if (line.startsWith(LAUNCHED)) return finish();
        if (!parsers) start(null);
        if (!parsers) return;
        queue([...parsers.rustc.push(stripLevelTag(line)), ...parsers.yog.push(line)]);
      }),
      // A game exiting (no payload) ends a run whose build never launched it.
      listenTo(EVENT.workflowExit, finish),
    ]);
  }, [root, project]);
  return null;
}

/**
 * A saved `.yui`/`.yres`/`.yblock`/`.yitem` file's check (see
 * `regenerateScreen`): `log` is yog's output in folder `root` — its error
 * and warnings. Replaces that file's live set.
 */
export function setSavedFileDiagnostics(path: string, root: string, log: string): void {
  const parser = createYogParser({ root, origin: "live" });
  const items = log.split("\n").flatMap((line) => parser.push(line));
  // A failure that names no file is still about this one.
  setDiagnostics(liveSet(path), items.map((d) => (d.file ? d : { ...d, file: path })));
}

/** Drops every on-save check — the project closed. */
export function clearLiveDiagnostics(): void {
  clearDiagnostics({ origin: "live" });
}
