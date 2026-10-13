import { readFileSync } from "node:fs";
import { test, vi, expect } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { getDiagnostics } from "substrate-platform-ui";

const handlers = new Map<string, ((p: unknown) => void)[]>();
vi.mock("../events", async (orig) => {
  const real = await orig<typeof import("../events")>();
  return {
    ...real,
    listenTo: (e: string, h: (p: unknown) => void) => {
      handlers.set(e, [...(handlers.get(e) ?? []), h]);
      return Promise.resolve(() => {});
    },
  };
});
const fire = (e: string, p: unknown) => handlers.get(e)?.forEach((h) => h(p));

test("sync", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { BuildDiagnosticsSync } = await import("./buildDiagnostics");
  const root = "/home/f000nk/Projects/yog/Yog-VLSI";
  const el = document.createElement("div");
  await act(async () => createRoot(el).render(createElement(BuildDiagnosticsSync, { root, project: "Yog-VLSI" })));
  const log = readFileSync("/tmp/claude-1000/-home-f000nk-Projects-yog/025809e8-215b-4c45-91be-91e978e0657e/scratchpad/buildlog.txt", "utf8");
  fire("workflow-start", { root });
  for (const line of log.split("\n")) fire("workflow-output", line);
  fire("workflow-exit", { success: false, cancelled: false });
  await new Promise((r) => setTimeout(r, 300));
  console.log("count", getDiagnostics().length);
  expect(getDiagnostics().length).toBeGreaterThan(0);
});
