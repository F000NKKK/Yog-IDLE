// Tests run against the real CLI: `cli()` goes to a `yog serve` this
// process starts (the IDE's backend does the same), so a model's test
// checks what the CLI really reads and writes.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { afterAll, vi } from "vitest";
import { program } from "../data/yogIds.generated";

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

let service: ChildProcessWithoutNullStreams | undefined;
const pending = new Map<number, Pending>();
let nextId = 1;

function start(): ChildProcessWithoutNullStreams {
  const child = spawn(program.CLI, [program.SERVE]);
  createInterface({ input: child.stdout }).on("line", (line) => {
    const reply = JSON.parse(line) as { id: number; result?: unknown; error?: unknown };
    const p = pending.get(reply.id);
    pending.delete(reply.id);
    if ("error" in reply) p?.reject(reply.error);
    else p?.resolve(reply.result ?? null);
  });
  return child;
}

vi.mock("../cli", () => ({
  cli: (method: string, params: Record<string, unknown> = {}) =>
    new Promise((resolve, reject) => {
      service ??= start();
      const id = nextId++;
      pending.set(id, { resolve, reject });
      service.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    }),
}));

afterAll(() => {
  service?.kill();
});
