import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button, ComponentList, FloatingWindow, Icon, t, useT, type ComponentListItem, type ComponentListSection, type ComponentStatus } from "substrate-platform-ui";
import { useProject } from "../ProjectContext";
import {
  canInstall,
  cancelInstall,
  detectEnvironment,
  installComponents,
  missingRequired,
  useEnvironment,
  type EnvironmentComponent,
} from "./environmentStore";
import "./Environment.css";

/** A component's name and description in the active language — JDKs carry their major version. */
export function componentText(c: EnvironmentComponent): { name: string; description: string } {
  const jdk = /^jdk-(\d+)$/.exec(c.id);
  if (jdk) {
    const major = jdk[1];
    return {
      name: t("JDK {major}", { major }),
      description: t("Java {major} for Minecraft run targets that need it — Eclipse Temurin, installed into Yog IDLE's tools folder.", { major }),
    };
  }
  return { name: t(c.name), description: t(c.description) };
}

const STATUS_LABELS: Record<EnvironmentComponent["status"], string> = {
  installed: "Installed",
  missing: "Not installed",
  outdated: "Update available",
  partial: "Incomplete",
};

/** The installer's sections, in order — a component goes to the first whose test matches its id. */
const SECTIONS: { id: string; title: string; test: (id: string) => boolean }[] = [
  { id: "rust", title: "Rust", test: (id) => ["rust", "toolchain", "targets"].includes(id) },
  { id: "build", title: "Build Tools", test: (id) => ["cargo-zigbuild", "zig"].includes(id) || id.startsWith("jdk-") },
  { id: "yog", title: "Yog Components", test: (id) => ["yog", "loader"].includes(id) },
  { id: "general", title: "General Tools", test: () => true },
];

/**
 * Tools > Install Components — Visual Studio Installer for the Yog
 * toolchain: every component with its status and version, Install/Update
 * per component or for the checked ones at once (each install confirmed
 * first — `installComponents`), progress inline and in Output
 * (Environment). Opening it re-checks, including for newer versions.
 */
export function EnvironmentWindow({ onClose, onOpenOptions }: { onClose: () => void; onOpenOptions: () => void }) {
  const t = useT();
  const { project } = useProject();
  const root = project?.root ?? null;
  const env = useEnvironment();
  const report = env.report;
  const busy = env.queue.length > 0;
  const [selected, setSelected] = useState<Set<string> | null>(null);

  useEffect(() => {
    void detectEnvironment(root, true);
  }, [root]);

  // Until the user picks, everything that can be installed and is needed is checked.
  const defaultSelection = useMemo(
    () => new Set((report?.components ?? []).filter((c) => canInstall(c) && c.required).map((c) => c.id)),
    [report]
  );
  const chosen = new Set([...(selected ?? defaultSelection)].filter((id) => report?.components.some((c) => c.id === id && canInstall(c))));

  function toggle(id: string, on: boolean) {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  }

  const items: ComponentListItem[] = (report?.components ?? []).map((c) => {
    const { name, description } = componentText(c);
    const working = env.queue.includes(c.id);
    const failed = env.failed[c.id];
    const progress = env.progress[c.id];
    let status: ComponentStatus = c.status;
    let statusLabel = t(STATUS_LABELS[c.status]);
    if (working) {
      status = "working";
      statusLabel = env.queue[0] === c.id ? t("Installing…") : t("Queued");
    } else if (failed) {
      status = "failed";
      statusLabel = t("Failed");
    }
    const version = c.version ? (c.status === "outdated" && c.latest ? `${c.version} → ${c.latest}` : c.version) : c.latest ? t("latest: {version}", { version: c.latest }) : undefined;
    const actions: ComponentListItem["actions"] = [];
    if (!working && canInstall(c)) {
      // A component that needs another one first (targets need rustup) brings it along.
      const dependency = c.dependsOn ? report?.components.find((d) => d.id === c.dependsOn) : undefined;
      const ids = dependency && dependency.status === "missing" && canInstall(dependency) ? [dependency.id, c.id] : [c.id];
      actions.push({
        label: c.status === "missing" ? t("Install") : t("Update"),
        variant: c.required ? "primary" : "subtle",
        disabled: busy,
        onClick: () => void installComponents(ids, root),
      });
    }
    if (!c.installable && c.manualUrl && c.status !== "installed") {
      const url = c.manualUrl;
      actions.push({ label: t("Download..."), onClick: () => void openUrl(url) });
    }
    return {
      id: c.id,
      name,
      description,
      status,
      statusLabel,
      version,
      detail: c.detail ?? undefined,
      error: failed,
      progress: working && env.queue[0] === c.id ? (progress?.fraction ?? null) : working ? 0 : undefined,
      progressLabel: working ? progress?.message : undefined,
      optional: !c.required,
      actions,
      selected: chosen.has(c.id),
      onSelectedChange: canInstall(c) && !busy ? (on) => toggle(c.id, on) : undefined,
    };
  });

  const sections: ComponentListSection[] = SECTIONS.map((section) => ({
    id: section.id,
    title: t(section.title),
    items: items.filter((item) => SECTIONS.find((s) => s.test(item.id)) === section),
  }));

  const missing = report ? missingRequired(report) : [];
  const summary = !report
    ? env.error
      ? t("Couldn't check the environment: {error}", { error: env.error })
      : t("Checking…")
    : missing.length === 0
      ? t("Everything Yog needs to build and run mods is installed.")
      : t("Missing or out of date: {names}.", { names: missing.map((c) => componentText(c).name).join(", ") });

  return (
    <FloatingWindow
      title={t("Yog Environment")}
      icon={<Icon name="settings" size={14} />}
      onClose={onClose}
      width={760}
      className="environment-window"
    >
      <div className="environment-body">
        <p className={`environment-summary${report && missing.length > 0 ? " is-warning" : ""}`}>{summary}</p>
        <div className="environment-list">
          <ComponentList sections={sections} emptyLabel={env.checking ? t("Checking…") : undefined} />
        </div>
        {report && (
          <details className="environment-details">
            <summary>{t("Details")}</summary>
            <dl className="environment-facts">
              <dt>{t("Rust toolchain")}</dt>
              <dd>{report.rustToolchain}</dd>
              <dt>{t("This platform")}</dt>
              <dd>{report.hostTag ?? t("unsupported")}</dd>
              <dt>yog</dt>
              <dd>{report.yogPath ?? t("not found")}</dd>
              <dt>{t("Tools folder")}</dt>
              <dd>{report.toolsDir}</dd>
              <dt>{t("Loader checkout")}</dt>
              <dd>{report.loaderRepo ?? t("not found")}</dd>
              <dt>{t("JDKs")}</dt>
              <dd>{report.jdks.length === 0 ? t("none found") : report.jdks.map((j) => `${j.version} (${j.home})`).join("\n")}</dd>
            </dl>
            <p className="environment-note">{t("Minecraft itself is downloaded by the loader's Gradle build the first time a run target starts.")}</p>
          </details>
        )}
        <div className="environment-footer">
          <Button variant="ghost" onClick={onOpenOptions}>
            {t("Options...")}
          </Button>
          <span className="environment-footer-spacer" />
          {busy ? (
            <Button onClick={cancelInstall}>{t("Cancel Install")}</Button>
          ) : (
            <Button disabled={env.checking} onClick={() => void detectEnvironment(root, true)}>
              {env.checking ? t("Checking…") : t("Check Again")}
            </Button>
          )}
          <Button variant="primary" disabled={busy || chosen.size === 0} onClick={() => void installComponents([...chosen], root)}>
            {chosen.size > 0 ? t("Install Selected ({count})", { count: chosen.size }) : t("Install Selected")}
          </Button>
        </div>
      </div>
    </FloatingWindow>
  );
}
