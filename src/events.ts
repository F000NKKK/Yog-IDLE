// The Tauri events the IDE listens to and emits — names as in
// `src-tauri/src/events.rs`, with their payloads, so `listenTo`/`emitTo`
// can't get either wrong. (`pty-*` belong to the platform's terminal.)

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

export const EVENT = {
  /** Output sources: one line of text each. */
  buildOutput: "workflow-output",
  gameOutput: "game-output",
  debugOutput: "debug-output",
  environmentOutput: "environment-output",
  gitOutput: "git-output",
  /** IDE-side messages (`reportError`, the Project Explorer, the designer) — emitted by the front end only. */
  ideOutput: "ide-output",

  workflowStart: "workflow-start",
  workflowExit: "workflow-exit",
  gameStatus: "game-status",
  hotReload: "hot-reload",
  debugAttached: "debug-attached",
  debugAttachFailed: "debug-attach-failed",
  debugFailed: "debug-failed",
  debugStopped: "debug-stopped",

  environmentProgress: "environment-progress",
  environmentInstallDone: "environment-install-done",
  environmentInstallFinished: "environment-install-finished",
} as const;

export interface GameStatusEvent {
  stage: "starting" | "ready" | "exited";
  pid: number | null;
  mods: { id: string; name: string; version: string }[];
}

export interface HotReloadEvent {
  stage: "building" | "reloading" | "done";
  modId: string;
  ok: boolean | null;
  message: string;
}

/** `workflow-exit`'s payload when a Build/Publish run (not a game) ended. */
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

export interface EnvironmentProgressEvent {
  component: string;
  fraction: number | null;
  message: string;
}

export interface EnvironmentInstallDoneEvent {
  component: string;
  success: boolean;
  cancelled: boolean;
  error: string | null;
}

type Payloads = {
  "workflow-output": string;
  "game-output": string;
  "debug-output": string;
  "environment-output": string;
  "git-output": string;
  "ide-output": string;
  /** The project the run builds. */
  "workflow-start": { root: string } | null;
  /** A game exiting fires this too, with no payload. */
  "workflow-exit": WorkflowExitEvent | null;
  "game-status": GameStatusEvent;
  "hot-reload": HotReloadEvent;
  /** The debugged process's pid. */
  "debug-attached": number;
  "debug-attach-failed": string;
  "debug-failed": string;
  "debug-stopped": DebugStoppedEvent;
  "environment-progress": EnvironmentProgressEvent;
  "environment-install-done": EnvironmentInstallDoneEvent;
  "environment-install-finished": unknown;
};

export type EventName = keyof Payloads;
export type OutputEvent = (typeof EVENT)["buildOutput" | "gameOutput" | "debugOutput" | "environmentOutput" | "gitOutput" | "ideOutput"];

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
