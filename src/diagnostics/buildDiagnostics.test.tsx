import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDiagnostics } from "substrate-platform-ui";
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
const output = (log: string) => log.split("\n").forEach((line) => fire(yogEvents.buildOutput, line));

const ROOT = "/p/vlsi";
/** One platform's share of a failing `yog build`, as the Build output shows it. */
const PLATFORM = [
  "   Compiling yog-vlsi v0.2.0 (/p/vlsi/.yog-build)",
  "    Building [=====> ] 76/77: yog-vlsi   \rerror[E0432]: unresolved import `crate::vm::Tier`",
  "  --> ../src/alu_ui.rs:22:5",
  "   |",
  "22 | use crate::vm::Tier;",
  "[error] error[E0432]: unresolved import `crate::nbt`",
  " --> ../src/chip.rs:7:5",
  "",
].join("\n");

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const { BuildDiagnosticsSync } = await import("./buildDiagnostics");
  await act(async () => createRoot(document.createElement("div")).render(createElement(BuildDiagnosticsSync, { root: ROOT })));
});
beforeEach(() => fire("workflow-start", { root: ROOT }));

const shown = () => getDiagnostics().map((d) => `${d.code} ${d.file}:${d.line}`);

describe("BuildDiagnosticsSync", () => {
  it("lists each error once across platforms, including one behind cargo's progress bar", () => {
    output(`==> building yog-vlsi 0.2.0 with \`cargo zigbuild\`\n${PLATFORM}\n${PLATFORM}`);
    fire("workflow-exit", { success: false, cancelled: false });
    expect(shown()).toEqual(["E0432 /p/vlsi/src/alu_ui.rs:22", "E0432 /p/vlsi/src/chip.rs:7"]);
  });

  it("drops rustc's notes about the cross-compiling host", () => {
    output('==> building yog-vlsi 0.2.0\nwarning: invoking `"xcrun" "--sdk" "macosx" "--show-sdk-path"` to find MacOSX.sdk failed: No such file or directory (os error 2)\n');
    fire("workflow-exit", { success: true, cancelled: false });
    expect(shown()).toEqual([]);
  });

  it("reads a run's build, which fires no workflow-start", () => {
    fire("workflow-exit", { success: true, cancelled: false });
    output(`==> building yog-vlsi 0.2.0 with \`cargo zigbuild\`\n${PLATFORM}`);
    fire("workflow-exit", null);
    expect(shown()).toHaveLength(2);
    // Output after the build doesn't replace what it found.
    output("[error] hot reload: no game running");
    expect(shown()).toHaveLength(2);
  });
});
