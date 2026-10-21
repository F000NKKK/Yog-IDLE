// The CLI as a service (`yog serve`, through the backend's `cli` command):
// how the front end reads and writes every Yog format — the formats live
// in the CLI, so a new one needs a new `yog`, not a new IDE. Requests and
// answers are binary Yog Data, written and read here; the backend only
// carries them.
import { yog } from "./host.generated";
import { invokeCommand } from "substrate-platform-ui";
import { decode, encode, type DecodeOptions, type Value } from "./data/binary";
import { RESULT_ERR, RESULT_OK } from "./data/yogDataBinary.generated";
import { serveRequest } from "./data/yogIds.generated";

/**
 * Calls `method` of the CLI service; rejects with its error (a message, or
 * `{ message, line }`). `ordered`: the answer's maps as `Map`s in order.
 */
export async function cli<T>(method: string, params: Record<string, unknown> = {}, opts: DecodeOptions = {}): Promise<T> {
  const request = encode({ [serveRequest.METHOD]: method, [serveRequest.PARAMS]: params as Value });
  const reply = decode(new Uint8Array(await invokeCommand<ArrayBuffer>(yog.code.cli, request)), opts);
  const side = (key: string): Value | undefined =>
    reply instanceof Map ? reply.get(key) : (reply as { [key: string]: Value })[key];
  const err = side(RESULT_ERR);
  if (err !== undefined) throw err;
  return side(RESULT_OK) as T;
}
