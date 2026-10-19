import { useCallback, useEffect, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, CheckField, CommitTextField, FormField, FormPage, FormSection, Icon, IconButton, notify, SETTINGS_HISTORY, t, undoable, useGlobalState, useGlobalStateStore, useT } from "substrate-platform-ui";
import {
  BUILD_SETTINGS_KEY,
  applyBuildSettings,
  isBuildSettings,
  missingTools,
  normalizeBuildSettings,
  openInstaller,
  toolsStatus,
  useToolsStatus,
  type BuildSettings,
} from "./toolsStore";
import "./Build.css";

/** The Build page's labels — for Options' search. */
export const buildSettingsKeywords = ["Build for this platform only", "Local yog-api crate", "YOG_API_PATH", "YOG_TARGETS", "Yog Installer"];

/** The options, read and written through `state.json`, handed to the backend on every change; undoable. */
function useBuildSettings(): [BuildSettings, (patch: Partial<BuildSettings>) => void] {
  const [stored, setStored] = useGlobalState<unknown>(BUILD_SETTINGS_KEY, {}, isBuildSettings);
  const settings = normalizeBuildSettings(stored);
  const latest = useRef(settings);
  latest.current = settings;
  const change = useCallback(
    (patch: Partial<BuildSettings>) => {
      const apply = (value: BuildSettings) => {
        latest.current = value;
        setStored(value);
        void applyBuildSettings(value);
      };
      undoable(SETTINGS_HISTORY, latest.current, { ...latest.current, ...patch }, apply, `build:${Object.keys(patch).join(",")}`);
    },
    [setStored],
  );
  return [settings, change];
}

/**
 * Tools > Options > Build: how mods are built here. What's installed —
 * the CLI, Rust, JDKs, the loader SDK — is Yog Installer's.
 */
export function BuildSettingsPage() {
  const t = useT();
  const [settings, change] = useBuildSettings();
  const status = useToolsStatus();
  return (
    <FormPage title={t("Build")} actions={<Button onClick={() => void openInstaller()}>{t("Yog Installer...")}</Button>}>
      <FormSection title={t("Build")}>
        <FormField label={t("Local yog-api crate")} hint={t("Builds every mod against this yog-api (YOG_API_PATH) instead of crates.io — needed for hot reload of a locally built loader.")}>
          <div className="build-path-row">
            <CommitTextField value={settings.yogApiPath} placeholder="crates.io" onCommit={(text) => change({ yogApiPath: text.trim() })} />
            <IconButton
              size={28}
              title={t("Browse...")}
              aria-label={t("Browse...")}
              onClick={async () => {
                const chosen = await open({ directory: true, defaultPath: settings.yogApiPath || undefined });
                if (typeof chosen === "string") change({ yogApiPath: chosen });
              }}
            >
              <Icon name="folderOpen" />
            </IconButton>
          </div>
        </FormField>
        <CheckField checked={settings.hostOnly} onChange={(hostOnly) => change({ hostOnly })} label={t("Build for this platform only ({platform})", { platform: status?.hostTag ?? "?" })} />
      </FormSection>
    </FormPage>
  );
}

/**
 * Mounted once: hands the stored options to the backend, then tells once
 * when something Yog needs isn't installed — Yog Installer sets it up.
 */
export function BuildSettingsSync() {
  const store = useGlobalStateStore();
  const checked = useRef(false);
  useEffect(() => {
    if (store.scope !== "global" || checked.current) return;
    checked.current = true;
    void applyBuildSettings(normalizeBuildSettings(store.get(BUILD_SETTINGS_KEY))).then(async () => {
      const missing = missingTools(await toolsStatus());
      if (missing.length === 0) return;
      notify({
        level: "warn",
        message: t("Yog needs components that aren't installed: {names}. Tools > Yog Installer... sets them up.", { names: missing.map((n) => t(n)).join(", ") }),
        timeout: 0,
      });
    });
  }, [store]);
  return null;
}
