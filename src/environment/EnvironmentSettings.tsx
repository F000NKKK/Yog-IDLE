import { useCallback, useEffect, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Button,
  CheckField,
  CommitTextField,
  FormField,
  FormPage,
  FormSection,
  Icon,
  IconButton,
  SelectField,
  notify,
  t,
  useT,
} from "substrate-platform-ui";
import { useProject } from "../ProjectContext";
import { useGlobalState, useGlobalStateStore } from "../WorkspaceContext";
import {
  ENVIRONMENT_SETTINGS_KEY,
  applyEnvironmentSettings,
  detectEnvironment,
  isEnvironmentSettings,
  listenToInstallEvents,
  missingRequired,
  normalizeSettings,
  useEnvironment,
  type EnvironmentSettings as Settings,
} from "./environmentStore";
import { componentText } from "./EnvironmentWindow";

/** The Options' Environment page — read and written through the app-wide `state.json`, and handed to the backend on every change. */
export function useEnvironmentSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [stored, setStored] = useGlobalState<unknown>(ENVIRONMENT_SETTINGS_KEY, {}, isEnvironmentSettings);
  const settings = normalizeSettings(stored);
  const latest = useRef(settings);
  latest.current = settings;
  const change = useCallback(
    (patch: Partial<Settings>) => {
      const next = { ...latest.current, ...patch };
      latest.current = next;
      setStored(next);
      void applyEnvironmentSettings(next);
    },
    [setStored]
  );
  return [settings, change];
}

/** The Environment page's settings labels — for Options' search. */
export const environmentSettingsKeywords = [
  "yog executable",
  "CARGO_HOME",
  "Tools folder",
  "JDK",
  "Java",
  "Yog Mod Loader checkout",
  "Build for this platform only",
  "Local yog-api crate",
  "Check the environment on startup",
];

async function browseFolder(current: string): Promise<string | null> {
  const chosen = await open({ directory: true, defaultPath: current || undefined });
  return typeof chosen === "string" ? chosen : null;
}

/** The "..." button that picks a folder (or file) for the field before it. */
function BrowseButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <IconButton size={28} title={t("Browse...")} aria-label={t("Browse...")} onClick={onClick}>
      <Icon name="folderOpen" />
    </IconButton>
  );
}

/** A path field with a Browse button — commits on Enter/blur like the rest. Empty shows what's used instead, as the placeholder. */
function PathField({ value, placeholder, onCommit, file }: { value: string; placeholder?: string; onCommit: (value: string) => void; file?: boolean }) {
  return (
    <div className="environment-jdk-row">
      <CommitTextField value={value} placeholder={placeholder} onCommit={(text) => onCommit(text.trim())} />
      <BrowseButton
        onClick={async () => {
          const chosen = file ? await open({ defaultPath: value || undefined }) : await browseFolder(value);
          if (typeof chosen === "string") onCommit(chosen);
        }}
      />
    </div>
  );
}

/**
 * Tools > Options > Environment: where the toolchain lives and how mods
 * are built — the backend applies it to every `yog`/`cargo` it starts
 * (Build, Publish, installs; Run/Debug once the IDE is restarted).
 */
export function EnvironmentSettingsPage({ onOpenInstaller }: { onOpenInstaller: () => void }) {
  const t = useT();
  const { project } = useProject();
  const [settings, change] = useEnvironmentSettings();
  const env = useEnvironment();
  const report = env.report;

  useEffect(() => {
    if (!env.report && !env.checking) void detectEnvironment(project?.root ?? null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const majors = [...new Set([...(report?.components ?? []).flatMap((c) => /^jdk-(\d+)$/.exec(c.id)?.[1] ?? []), ...Object.keys(settings.jdks)])].sort(
    (a, b) => Number(a) - Number(b)
  );
  const missing = report ? missingRequired(report) : [];

  return (
    <FormPage
      title={t("Environment")}
      actions={<Button onClick={onOpenInstaller}>{t("Install Components...")}</Button>}
    >
      {missing.length > 0 && (
        <p className="environment-summary is-warning">{t("Missing or out of date: {names}.", { names: missing.map((c) => componentText(c).name).join(", ") })}</p>
      )}
      <FormSection title={t("Tools")}>
        <FormField label={t("yog executable")} hint={t("Empty: found in PATH or ~/.cargo/bin.")}>
          <PathField file value={settings.yogPath} placeholder={report?.yogPath ?? t("not found")} onCommit={(yogPath) => change({ yogPath })} />
        </FormField>
        <FormField label="CARGO_HOME" hint={t("Where rustup, cargo and cargo-installed tools (yog, cargo-zigbuild) live.")}>
          <PathField value={settings.cargoHome} placeholder="~/.cargo" onCommit={(cargoHome) => change({ cargoHome })} />
        </FormField>
        <FormField label={t("Tools folder")} hint={t("Where Yog IDLE installs JDKs, zig and the loader checkout.")}>
          <PathField value={settings.toolsDir} placeholder={report?.toolsDir} onCommit={(toolsDir) => change({ toolsDir })} />
        </FormField>
      </FormSection>

      <FormSection title={t("Java")}>
        {majors.length === 0 && <p className="environment-note">{t("No run target needs a particular Java version.")}</p>}
        {majors.map((major) => {
          const detected = (report?.jdks ?? []).filter((j) => String(j.major) === major);
          const current = settings.jdks[major] ?? "";
          const options = [
            { value: "", label: t("Newest detected") },
            ...detected.map((j) => ({ value: j.home, label: `${j.version}${j.vendor ? ` (${j.vendor})` : ""}` })),
            ...(current && !detected.some((j) => j.home === current) ? [{ value: current, label: current }] : []),
          ];
          return (
            <FormField key={major} label={t("JDK {major}", { major })} hint={t("Run targets get JAVA_HOME from here when their yog.toml doesn't set it.")}>
              <div className="environment-jdk-row">
                <SelectField
                  value={current}
                  options={options}
                  aria-label={t("JDK {major}", { major })}
                  onChange={(home) => change({ jdks: { ...settings.jdks, [major]: home } })}
                />
                <BrowseButton
                  onClick={async () => {
                    const home = await browseFolder(current);
                    if (home) change({ jdks: { ...settings.jdks, [major]: home } });
                  }}
                />
              </div>
            </FormField>
          );
        })}
      </FormSection>

      <FormSection title={t("Build")}>
        <FormField label={t("Yog Mod Loader checkout")} hint={t("Empty: next to the project, or in the tools folder.")}>
          <PathField value={settings.loaderRepo} placeholder={report?.loaderRepo ?? t("not found")} onCommit={(loaderRepo) => change({ loaderRepo })} />
        </FormField>
        <FormField label={t("Local yog-api crate")} hint={t("Builds every mod against this yog-api (YOG_API_PATH) instead of crates.io — needed for hot reload of a locally built loader.")}>
          <PathField value={settings.yogApiPath} placeholder={t("crates.io")} onCommit={(yogApiPath) => change({ yogApiPath })} />
        </FormField>
        <CheckField
          checked={settings.hostOnly}
          onChange={(hostOnly) => change({ hostOnly })}
          label={t("Build for this platform only ({platform})", { platform: report?.hostTag ?? "?" })}
        />
        <CheckField
          checked={!settings.skipStartupCheck}
          onChange={(on) => change({ skipStartupCheck: !on })}
          label={t("Check the environment on startup")}
        />
      </FormSection>
    </FormPage>
  );
}

/**
 * Mounted once: hands the stored options to the backend, wires install
 * events into the store, and runs the startup check (no network) — telling
 * the user once if something required is missing.
 */
export function EnvironmentSync({ onOpenInstaller }: { onOpenInstaller: () => void }) {
  const store = useGlobalStateStore();
  const { project } = useProject();
  const rootRef = useRef<string | null>(null);
  rootRef.current = project?.root ?? null;
  const checked = useRef(false);
  const openInstaller = useRef(onOpenInstaller);
  openInstaller.current = onOpenInstaller;

  useEffect(() => listenToInstallEvents(() => rootRef.current), []);

  useEffect(() => {
    if (store.scope !== "global" || checked.current) return;
    checked.current = true;
    const settings = normalizeSettings(store.get(ENVIRONMENT_SETTINGS_KEY));
    void applyEnvironmentSettings(settings).then(async () => {
      if (settings.skipStartupCheck) return;
      const report = await detectEnvironment(rootRef.current, false);
      const missing = report ? missingRequired(report) : [];
      if (missing.length === 0) return;
      notify({
        level: "warn",
        message: t("Yog needs components that aren't installed: {names}. Tools > Install Components... sets them up.", {
          names: missing.map((c) => componentText(c).name).join(", "),
        }),
        timeout: 0,
      });
    });
  }, [store]);

  return null;
}
