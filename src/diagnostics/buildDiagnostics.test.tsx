import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDiagnostics } from "substrate-platform-ui";
import { frame, type Value } from "../data/binary";
import { severity, type Diagnostic as YogDiagnostic } from "../data/yogDataBinary.generated";
import { yogEvents } from "../host.generated";

const handlers = new Map<string, ((payload: unknown) => void)[]>();
vi.mock("../events", async (original) => ({
  ...(await original<typeof import("../events")>()),
  listenTo: (event: string, handler: (payload: unknown) => void) => {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    return Promise.resolve(() => {});
  },
}));
const fire = (event: string, payload: unknown) => handlers.get(event)?.forEach((h) => h(payload));
/** A record as `yog build` writes it to its diagnostics file, passed on. */
const report = (d: YogDiagnostic) => fire(yogEvents.buildDiagnostic, Array.from(frame(d as unknown as Value)));

const ROOT = "/p/vlsi";
const UNRESOLVED: YogDiagnostic = { severity: severity.ERROR, code: "E0432", message: "unresolved import `crate::vm::Tier`", file: "src/alu_ui.rs", line: 22, col: 5, tool: "rustc" };
const SCREEN: YogDiagnostic = { severity: severity.WARNING, code: "YB0004", message: "unknown style", file: "src/main.yui", line: 3, path: [{ type: "key", value: "style" }] };

beforeAll(async () => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const { BuildDiagnosticsSync } = await import("./buildDiagnostics");
  await act(async () => createRoot(document.createElement("div")).render(createElement(BuildDiagnosticsSync, { root: ROOT })));
});
beforeEach(() => fire(yogEvents.workflowStart, { root: ROOT }));

const shown = () => {
  vi.runAllTimers();
  return getDiagnostics().map((d) => `${d.severity} ${d.code} ${d.file}:${d.line} ${d.message}`);
};

describe("BuildDiagnosticsSync", () => {
  it("lists each record once, at its file under the mod's folder", () => {
    report(UNRESOLVED);
    report(UNRESOLVED);
    report(SCREEN);
    expect(shown()).toEqual([
      "error E0432 /p/vlsi/src/alu_ui.rs:22 unresolved import `crate::vm::Tier`",
      "warning YB0004 /p/vlsi/src/main.yui:3 style: unknown style",
    ]);
  });

  it("starts over with a run's build", () => {
    report(UNRESOLVED);
    expect(shown()).toHaveLength(1);
    fire(yogEvents.gameStatus, { stage: "starting", pid: null, mods: [] });
    expect(shown()).toEqual([]);
  });
});
