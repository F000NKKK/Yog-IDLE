import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { notify, showDialog, t } from "substrate-platform-ui";
import { setOutputSource } from "../outputSource";
import { reportError } from "../reportError";

/**
 * The machine's Yog toolchain as `environment.rs` sees it — detected on
 * startup and on demand (Tools > Check Environment), installed through
 * `environment_install` with every install confirmed first. Module-level
 * (like `outputSource`): the Environment window, the Options page and the
 * startup check all share one report and one install in flight.
 */

/** Tools > Options > Environment (`environment::Settings`). Empty strings mean "detect/default". */
export interface EnvironmentSettings {
  yogPath: string;
  cargoHome: string;
  toolsDir: string;
  /** Java major ("17", "21") → JDK home. */
  jdks: Record<string, string>;
  loaderRepo: string;
  hostOnly: boolean;
  yogApiPath: string;
  skipStartupCheck: boolean;
}

const DEFAULT_ENVIRONMENT_SETTINGS: EnvironmentSettings = {
  yogPath: "",
  cargoHome: "",
  toolsDir: "",
  jdks: {},
  loaderRepo: "",
  hostOnly: false,
  yogApiPath: "",
  skipStartupCheck: false,
};

/** Key in the app-wide `state.json` — `environment::SETTINGS_KEY`. */
export const ENVIRONMENT_SETTINGS_KEY = "environment.settings";

export function isEnvironmentSettings(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stored value with any missing key filled in from the defaults. */
export function normalizeSettings(value: unknown): EnvironmentSettings {
  const stored = isEnvironmentSettings(value) ? (value as Partial<EnvironmentSettings>) : {};
  return { ...DEFAULT_ENVIRONMENT_SETTINGS, ...stored, jdks: { ...(stored.jdks ?? {}) } };
}

export type ComponentState = "installed" | "missing" | "outdated" | "partial";

export interface EnvironmentComponent {
  id: string;
  /** English — shown through `t`. */
  name: string;
  description: string;
  status: ComponentState;
  version: string | null;
  latest: string | null;
  detail: string | null;
  installable: boolean;
  manualUrl: string | null;
  required: boolean;
  dependsOn: string | null;
}

export interface DetectedJdk {
  home: string;
  version: string;
  major: number;
  vendor: string | null;
  managed: boolean;
}

export interface EnvironmentReport {
  components: EnvironmentComponent[];
  jdks: DetectedJdk[];
  rustToolchain: string;
  hostTag: string | null;
  toolsDir: string;
  loaderRepo: string | null;
  yogPath: string | null;
}

export interface InstallProgress {
  /** 0..1, or `null` while it can't tell (a command running). */
  fraction: number | null;
  message: string;
}

export interface EnvironmentStore {
  report: EnvironmentReport | null;
  checking: boolean;
  /** Why the last detection failed. */
  error: string | null;
  /** Components queued or being installed, in order — the first one is the current one. */
  queue: string[];
  progress: Record<string, InstallProgress>;
  /** Components whose last install failed: their error. */
  failed: Record<string, string>;
}

let state: EnvironmentStore = { report: null, checking: false, error: null, queue: [], progress: {}, failed: {} };
const subscribers = new Set<() => void>();

function update(patch: Partial<EnvironmentStore>) {
  state = { ...state, ...patch };
  subscribers.forEach((notify) => notify());
}

function subscribe(notify: () => void) {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

export function useEnvironment(): EnvironmentStore {
  return useSyncExternalStore(subscribe, () => state);
}

/** Hands the Options to the backend — every `yog`/`cargo` it spawns from now on uses them. */
export function applyEnvironmentSettings(settings: EnvironmentSettings): Promise<void> {
  return invoke<void>("environment_settings_set", { settings }).catch((err) => reportError(t("Failed to apply the Environment options: {error}", { error: String(err) })));
}

let detecting: Promise<EnvironmentReport | null> | null = null;

/**
 * Re-detects every component. `checkLatest` also asks crates.io/rustup for
 * newer versions (network — the explicit "Check Environment", not the
 * startup check).
 */
export function detectEnvironment(projectRoot: string | null, checkLatest: boolean): Promise<EnvironmentReport | null> {
  if (detecting) return detecting;
  update({ checking: true });
  detecting = invoke<EnvironmentReport>("environment_detect", { projectRoot, checkLatest })
    .then((report) => {
      update({ report, error: null });
      return report;
    })
    .catch((err) => {
      update({ error: String(err) });
      return null;
    })
    .finally(() => {
      detecting = null;
      update({ checking: false });
    });
  return detecting;
}

/** Components that block building/running a mod right now. */
export function missingRequired(report: EnvironmentReport): EnvironmentComponent[] {
  return report.components.filter((c) => c.required && c.status !== "installed");
}

/** A component with nothing to do — or one the IDE can't do anything about. */
export function canInstall(component: EnvironmentComponent): boolean {
  return component.installable && component.status !== "installed";
}

/** In dependency order: a component whose `dependsOn` is also chosen goes after it. */
function ordered(report: EnvironmentReport, ids: string[]): string[] {
  const order = report.components.map((c) => c.id);
  return [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/**
 * Installs/updates `ids` after the user confirms — listing exactly what
 * will be downloaded and where (user-level locations, never `sudo`).
 * Output goes to the "Environment" source; the store tracks progress.
 */
export async function installComponents(ids: string[], projectRoot: string | null): Promise<void> {
  const report = state.report;
  if (!report || ids.length === 0 || state.queue.length > 0) return;
  const chosen = ordered(report, ids)
    .map((id) => report.components.find((c) => c.id === id))
    .filter((c): c is EnvironmentComponent => !!c && c.installable);
  if (chosen.length === 0) return;
  const lines = chosen.map((c) => {
    const action = c.status === "outdated" || c.status === "partial" ? t("Update") : t("Install");
    const version = c.status === "outdated" && c.latest ? ` → ${c.latest}` : "";
    return `• ${action}: ${t(c.name)}${version}`;
  });
  // A JDK can go to this user's tools folder or to the OS's JDK folder for
  // every user (which asks for the administrator password) — the rest is per-user anyway.
  const withJdk = chosen.some((c) => c.id.startsWith("jdk-"));
  const answer = await showDialog({
    title: chosen.length === 1 ? t("Install {name}", { name: t(chosen[0].name) }) : t("Install Components"),
    message: [
      ...lines,
      "",
      withJdk
        ? t("Install the JDK just for you (into {dir}), or for all users of this computer (asks for the administrator password)?", { dir: report.toolsDir })
        : t("Downloads go to your user account only (rustup, ~/.cargo, and {dir}) — nothing needs administrator rights.", { dir: report.toolsDir }),
      t("Progress is shown in the Output window (Environment)."),
    ].join("\n"),
    buttons: withJdk
      ? [
          { id: "cancel", label: t("Cancel"), cancel: true },
          { id: "machine", label: t("For All Users") },
          { id: "user", label: t("Just for Me"), variant: "primary", default: true },
        ]
      : [
          { id: "cancel", label: t("Cancel"), cancel: true },
          { id: "user", label: t("Install"), variant: "primary", default: true },
        ],
  });
  if (answer.button !== "user" && answer.button !== "machine") return;
  const scope = answer.button;
  const queue = chosen.map((c) => c.id);
  const failed = { ...state.failed };
  for (const id of queue) delete failed[id];
  update({ queue, failed, progress: Object.fromEntries(queue.map((id) => [id, { fraction: null, message: t("Waiting…") }])) });
  setOutputSource("environment");
  try {
    await invoke("environment_install", { components: queue, projectRoot, scope });
  } catch (err) {
    update({ queue: [], progress: {} });
    reportError(t("Install failed to start: {error}", { error: String(err) }));
  }
}

export function cancelInstall(): void {
  void invoke("environment_cancel");
}

interface DonePayload {
  component: string;
  success: boolean;
  cancelled: boolean;
  error: string | null;
}

let projectRootForRecheck: () => string | null = () => null;

/**
 * Wires the backend's install events into the store — once, for the app's
 * lifetime (`EnvironmentSync`). `currentRoot` gives the project to re-detect
 * against once a batch ends.
 */
export function listenToInstallEvents(currentRoot: () => string | null): () => void {
  projectRootForRecheck = currentRoot;
  const unlistens = [
    listen<{ component: string; fraction: number | null; message: string }>("environment-progress", (e) => {
      update({ progress: { ...state.progress, [e.payload.component]: { fraction: e.payload.fraction, message: e.payload.message } } });
    }),
    listen<DonePayload>("environment-install-done", (e) => {
      const { component, success, cancelled, error } = e.payload;
      const progress = { ...state.progress };
      delete progress[component];
      const failed = { ...state.failed };
      if (!success && !cancelled && error) failed[component] = error;
      update({ queue: state.queue.filter((id) => id !== component), progress, failed });
      const name = t(state.report?.components.find((c) => c.id === component)?.name ?? component);
      if (success) notify({ level: "info", message: t("{name} installed.", { name }) });
      else if (cancelled) notify({ level: "warn", message: t("Installing {name} was cancelled.", { name }) });
      else notify({ level: "error", message: t("Installing {name} failed: {error}", { name, error: error ?? "" }) });
    }),
    listen("environment-install-finished", () => {
      // Whatever was queued after a failure never ran.
      update({ queue: [], progress: {} });
      void detectEnvironment(projectRootForRecheck(), false);
    }),
  ];
  return () => {
    unlistens.forEach((p) => p.then((f) => f()));
  };
}
