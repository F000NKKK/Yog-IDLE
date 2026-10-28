// Tests run against the real CLI: the backend's `cli` command goes to a
// `yog serve` this process starts (the IDE's backend does the same), so a
// model's test checks what the CLI really reads and writes — and `cli()`'s
// own Yog Data on the way.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterAll, vi } from "vitest";
import { program } from "../data/yogIds.generated";
import { CLI } from "./cliProgram";
import { FRAME_LEN_BYTES } from "../data/yogDataBinary.generated";
import { yog } from "../host.generated";

let service: ChildProcessWithoutNullStreams | undefined;
/** Who waits for each answer, in the order asked. */
const waiting: ((frame: Uint8Array) => void)[] = [];
let buffered = new Uint8Array(0);

function start(): ChildProcessWithoutNullStreams {
  const child = spawn(CLI, [program.SERVE]);
  child.stdout.on("data", (chunk: Buffer) => {
    const joined = new Uint8Array(buffered.length + chunk.length);
    joined.set(buffered);
    joined.set(chunk, buffered.length);
    buffered = joined;
    // Every whole frame, to whoever asked first.
    for (;;) {
      if (buffered.length < FRAME_LEN_BYTES) return;
      const len = new DataView(buffered.buffer, buffered.byteOffset).getUint32(0, true);
      if (buffered.length < FRAME_LEN_BYTES + len) return;
      waiting.shift()?.(buffered.slice(FRAME_LEN_BYTES, FRAME_LEN_BYTES + len));
      buffered = buffered.slice(FRAME_LEN_BYTES + len);
    }
  });
  return child;
}

vi.mock("substrate-platform-ui", async (original) => {
  const actual = await original<typeof import("substrate-platform-ui")>();
  return {
    ...actual,
    invokeCommand: (command: { command: string }, request: Uint8Array) => {
      if (command.command !== yog.code.cli.command) return actual.invokeCommand(command as never, request as never);
      return new Promise<ArrayBuffer>((resolve) => {
        service ??= start();
        waiting.push((answer) => resolve(answer.buffer as ArrayBuffer));
        const frame = new Uint8Array(FRAME_LEN_BYTES + request.length);
        new DataView(frame.buffer).setUint32(0, request.length, true);
        frame.set(request, FRAME_LEN_BYTES);
        service.stdin.write(frame);
      });
    },
  };
});

afterAll(() => {
  service?.kill();
});
