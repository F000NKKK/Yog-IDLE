import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Tools > Options > Build (`tools::Settings`). */
export interface BuildSettings {
  hostOnly: boolean;
  /** Empty: yog-api from crates.io. */
  yogApiPath: string;
}

export const DEFAULT_BUILD_SETTINGS: BuildSettings = { hostOnly: false, yogApiPath: "" };

/** Key in the app-wide `state.json` — `tools::SETTINGS_KEY`. */
export const BUILD_SETTINGS_KEY = "build.settings";

export function isBuildSettings(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stored value with any missing key filled in from the defaults. */
export function normalizeBuildSettings(value: unknown): BuildSettings {
  return { ...DEFAULT_BUILD_SETTINGS, ...(isBuildSettings(value) ? (value as Partial<BuildSettings>) : {}) };
}

/** Hands the options to the backend, for every `yog`/cargo it starts. */
export function applyBuildSettings(settings: BuildSettings): Promise<void> {
  return invoke("tools_settings_set", { settings });
}

/** `tools::Status` — what Yog needs here and has. */
export interface ToolsStatus {
  yog: string | null;
  loaderSdk: string | null;
  installer: string | null;
  hostTag: string | null;
}

export function toolsStatus(): Promise<ToolsStatus> {
  return invoke<ToolsStatus>("tools_status");
}

/** What Yog needs and this machine hasn't (English names, shown through `t`). */
export function missingTools(status: ToolsStatus): string[] {
  return [status.yog ? null : "Yog CLI", status.loaderSdk ? null : "Yog Mod Loader SDK"].filter((n): n is string => n !== null);
}

/** The status, read once when mounted. */
export function useToolsStatus(): ToolsStatus | null {
  const [status, setStatus] = useState<ToolsStatus | null>(null);
  useEffect(() => {
    toolsStatus().then(setStatus, () => setStatus(null));
  }, []);
  return status;
}

/** Tools > Yog Installer: starts it, or opens where to download it. */
export function openInstaller(): Promise<void> {
  return invoke<void>("open_installer");
}
