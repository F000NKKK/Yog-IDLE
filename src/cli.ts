// The CLI as a service (`yog serve`, through the backend's `cli` command):
// how the front end reads and writes every Yog format — the formats live
// in the CLI, so a new one needs a new `yog`, not a new IDE.
import { invokeYog } from "./invokeYog";

/** Calls `method` of the CLI service; rejects with its error (a message, or `{ message, line }`). */
export function cli<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return invokeYog<T>("code", "cli", { method, params });
}
