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
 * yog-cli report in the Build output. Mounted once, beside the Output
 * panel's own sync.
 */
export function BuildDiagnosticsSync({ root, project }: { root: string | null; project?: string }) {
  useEffect(() => {
    let parsers: BuildParsers | null = null;
    let pending: Diagnostic[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      addDiagnostics(BUILD_SET, pending);
      pending = [];
    };
    const queue = (items: Diagnostic[]) => {
      if (items.length === 0) return;
      pending.push(...items);
      timer ??= setTimeout(flush, FLUSH_DELAY_MS);
    };
    const start = (buildRoot: string | null) => {
      clearTimeout(timer);
      timer = undefined;
      pending = [];
      setDiagnostics(BUILD_SET, []);
      const at = buildRoot ?? root;
      parsers = at ? parsersFor(at, project) : null;
    };
    const finish = () => {
      if (!parsers) return;
      queue(parsers.rustc.flush());
      clearTimeout(timer);
      flush();
    };
    return listenAll([
      listenTo(EVENT.workflowStart, (payload) => start(payload?.root ?? null)),
      listenTo(EVENT.hotReload, (e) => {
        if (e.stage === "building") start(null);
        else finish();
      }),
      listenTo(EVENT.buildOutput, (line) => {
        if (!parsers) return;
        queue([...parsers.rustc.push(stripLevelTag(line)), ...parsers.yog.push(line)]);
      }),
      listenTo(EVENT.workflowExit, (payload) => {
        if (payload) finish();
      }),
    ]);
  }, [root, project]);
  return null;
}

/**
 * A saved `.yui`/`.yres`/`.yblock`/`.yitem` file's check (see
 * `regenerateScreen`): `log` is yog's output — an error message, or its
 * warnings on success. Replaces that file's live set.
 */
export function setSavedFileDiagnostics(path: string, root: string, log: string, failed: boolean): void {
  const parser = createYogParser({ root, origin: "live" });
  const lines = log.split("\n");
  // `yui_codegen` strips the `yog: error: ` prefix from a failure's lines —
  // put it back on the unindented ones (progress lines start with `==>`).
  const restore = (line: string) => (failed && /^[^\s=]/.test(line) && !line.startsWith("yog: error: ") ? `yog: error: ${line}` : line);
  const items = lines.flatMap((line) => parser.push(restore(line)));
  // A failure that names no file is still about this one.
  setDiagnostics(liveSet(path), items.map((d) => (d.file ? d : { ...d, file: path })));
}

/** Drops every on-save check — the project closed. */
export function clearLiveDiagnostics(): void {
  clearDiagnostics({ origin: "live" });
}
