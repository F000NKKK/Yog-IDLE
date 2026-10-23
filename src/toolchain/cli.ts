// The CLI as a service (`yog serve`, through the backend's `cli` command):
// how the front end reads and writes every Yog format — the formats live
// in the CLI, so a new one needs a new `yog`, not a new IDE. Requests and
// answers are binary Yog Data, written and read here; the backend only
// carries them. A failed call rejects with a typed `ServiceError` and puts
// its problems in the Error List until the same call succeeds.
import { yog } from "../host.generated";
import { invokeCommand, setDiagnostics, type Diagnostic } from "substrate-platform-ui";
import { decode, encode, type DecodeOptions, type Value } from "../data/binary";
import { RESULT_ERR, RESULT_OK, severity, type Diagnostic as YogDiagnostic } from "../data/yogDataBinary.generated";
import { yogDiagnostic } from "../diagnostics/yogDiagnostic";
import { program, requestProblem, serveParam, serveRequest } from "../data/yogIds.generated";

/** One problem of a failed call: what it is, what's wrong, and where (`yog_data::Diagnostic`). */
export type ServiceProblem = YogDiagnostic;

/** What a failed call answers (`yog_cli::serve::ServiceError`). */
export class ServiceError extends Error {
  constructor(
    readonly method: string,
    message: string,
    readonly problems: ServiceProblem[],
    /** The file the call was about, when it was about one. */
    readonly file?: string,
  ) {
    const at = problems.length === 1 && problems[0].line !== undefined ? `${problems[0].line}:${problems[0].col ?? 1}: ` : "";
    super(`${at}${message}`);
    this.name = "ServiceError";
  }
}

/**
 * The Error List's set of `method` called on `params`: its file and the
 * parameters naming what it's about — not a text it's handed, so the next
 * call on the same file replaces what an older text got wrong.
 */
function diagnosticsKey(method: string, params: Record<string, unknown>): string {
  const plain = Object.entries(params).filter(
    ([k, v]) => k !== serveParam.TEXT && (typeof v === "string" || typeof v === "number"),
  );
  return `cli:${method}:${plain.map(([k, v]) => `${k}=${String(v)}`).join("&")}`;
}

/** `problems` as the Error List shows them: at their file's line and column, `tool` reporting them. */
export function problemDiagnostics(problems: readonly ServiceProblem[], tool: string, file?: string): Diagnostic[] {
  return problems.map((p) => yogDiagnostic(p, { tool, file, origin: "live" }));
}

/** What `method` of the service is called in the Error List's Tool column. */
export const serviceTool = (method: string) => `${program.CLI} ${program.SERVE}: ${method}`;

function diagnostics(e: ServiceError): Diagnostic[] {
  const problems = e.problems.length > 0 ? e.problems : [{ severity: severity.ERROR, code: requestProblem.FAILED, message: e.message }];
  return problemDiagnostics(problems, serviceTool(e.method), e.file);
}

/**
 * Calls `method` of the CLI service; rejects with a `ServiceError`.
 * `ordered`: the answer's maps as `Map`s in order.
 */
export async function cli<T>(method: string, params: Record<string, unknown> = {}, opts: DecodeOptions = {}): Promise<T> {
  const request = encode({ [serveRequest.METHOD]: method, [serveRequest.PARAMS]: params as Value });
  const reply = decode(new Uint8Array(await invokeCommand<ArrayBuffer>(yog.code.cli, request)), opts);
  const side = (key: string): Value | undefined =>
    reply instanceof Map ? reply.get(key) : (reply as { [key: string]: Value })[key];
  const key = diagnosticsKey(method, params);
  const err = side(RESULT_ERR);
  if (err !== undefined) {
    const e = err as { message?: string; problems?: ServiceProblem[] } | Map<string, Value>;
    const get = (k: string) => (e instanceof Map ? e.get(k) : (e as Record<string, unknown>)[k]);
    const problems = ((get("problems") as ServiceProblem[] | undefined) ?? []).map((p) => (p instanceof Map ? (Object.fromEntries(p) as ServiceProblem) : p));
    const file = get("file");
    const error = new ServiceError(method, String(get("message") ?? ""), problems, typeof file === "string" ? file : undefined);
    setDiagnostics(key, diagnostics(error));
    throw error;
  }
  setDiagnostics(key, []);
  return side(RESULT_OK) as T;
}
