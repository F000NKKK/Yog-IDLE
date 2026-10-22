// The Tauri events the IDE listens to and emits — the backend's
// (`yogEvents`, generated) and Substrate's — with their payloads, so
// `listenTo`/`emitTo` can't get either wrong.

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { events as substrateEvents, type BackendMessage } from "substrate-platform-ui";
import { yogEvents } from "./host.generated";

export const EVENT = {
  ...yogEvents,
  /** Source Control's runs — Substrate's event. */
  gitOutput: substrateEvents.gitOutput,
  /** IDE-side messages (`reportError`, the Project Explorer, the designer) — Substrate's General output. */
  ideOutput: substrateEvents.ideOutput,
} as const;

export interface GameStatusEvent {
  stage: "starting" | "ready" | "exited";
  pid: number | null;
  mods: { id: string; name: string; version: string }[];
}

export interface HotReloadEvent {
  stage: "building" | "confirm" | "reloading" | "done";
  modId: string;
  ok: boolean | null;
  message: string;
  /** `stage == "confirm"`: what the new build registers that only a restart applies (`<kind> <id>`). */
  changes?: { added: string[]; removed: string[]; changed: string[] };
}

/** `yogEvents.workflowExit`'s payload when a Build/Publish run (not a game) ended. */
export interface WorkflowExitEvent {
  success: boolean;
  cancelled: boolean;
}

export interface DebugStackFrame {
  id: number;
  name: string;
  file: string;
  line: number;
}

export interface DebugThread {
  id: number;
  name: string;
  /** Stopped and inspectable — the debugger is non-stop, so most threads keep running. */
  stopped: boolean;
}

export interface DebugStoppedEvent {
  reason: "breakpoint" | "step" | "pause" | "signal" | "exited";
  stackTrace: DebugStackFrame[];
  /** Every thread of the game; all are stopped while paused. */
  threads: DebugThread[];
  /** The thread `stackTrace`/`registers` describe. */
  thread: number;
  /** General-purpose registers of `thread`: `[name, hex value]`. */
  registers: [string, string][];
}


type Payloads = {
  [yogEvents.buildOutput]: string;
  [yogEvents.gameOutput]: string;
  [yogEvents.debugOutput]: string;
  /** The project the run builds. */
  [yogEvents.workflowStart]: { root: string } | null;
  /** A game exiting fires this too, with no payload. */
  [yogEvents.workflowExit]: WorkflowExitEvent | null;
  [yogEvents.gameStatus]: GameStatusEvent;
  [yogEvents.hotReload]: HotReloadEvent;
  /** A Yog Data frame's bytes: one `yog_data::Diagnostic`. */
  [yogEvents.buildDiagnostic]: number[];
  /** The debugged process's pid. */
  [yogEvents.debugAttached]: number;
  [yogEvents.debugAttachFailed]: string;
  [yogEvents.debugFailed]: string;
  [yogEvents.debugStopped]: DebugStoppedEvent;
} & {
  /** Lines as Substrate's messages (and the IDE's own as text). */
  [K in typeof substrateEvents.gitOutput]: string | BackendMessage;
} & {
  [K in typeof substrateEvents.ideOutput]: string;
};

export type EventName = keyof Payloads;
export type OutputEvent = (typeof EVENT)["buildOutput" | "gameOutput" | "debugOutput" | "gitOutput" | "ideOutput"];

export function listenTo<E extends EventName>(event: E, handler: (payload: Payloads[E]) => void): Promise<UnlistenFn> {
  return listen<Payloads[E]>(event, (e) => handler(e.payload));
}

/** Emits an app-wide event; delivery failures are dropped (there's no one to tell). */
export function emitTo<E extends EventName>(event: E, payload: Payloads[E]): void {
  emit(event, payload).catch(() => {});
}

/** Several `listenTo`s as one cleanup, for an effect. */
export function listenAll(listeners: Promise<UnlistenFn>[]): () => void {
  return () => listeners.forEach((p) => p.then((unlisten) => unlisten()));
}
