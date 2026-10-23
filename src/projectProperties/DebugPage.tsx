import { Button, formatShortcut, FormPage, FormSection, Icon, openFile, useT } from "substrate-platform-ui";
import type { RunTarget } from "substrate-platform-ui";
import { useModRunTargets } from "../running/useModRunTargets";
import type { PageProps } from "./ProjectPropertiesWindow";

/**
 * Debug: the run targets Start launches. They aren't the project's — every
 * mod gets the same ones, from Yog's home: each loader and Minecraft
 * version of the loader SDK, plus the machine's own targets from its local
 * patch (`~/.yog/local.toml`), which is also where the SDK, the JDKs and
 * the launch environment are overridden.
 */
export function DebugPage({ root }: PageProps) {
  const t = useT();
  const { targets, localFile, error } = useModRunTargets(root);
  const groups = [...new Map(targets.map((tg) => [tg.group ?? tg.name, tg.groupLabel ?? tg.displayName ?? tg.name])).entries()];

  return (
    <FormPage
      title={t("Debug")}
      description={t("Run targets — what Start ({keys}) launches. Every mod has the same ones: each loader and Minecraft version of the loader SDK, and this machine's own.", { keys: formatShortcut("f5") })}
      actions={
        <Button disabled={!localFile} onClick={() => openFile({ path: localFile, name: "local.toml" })}>
          <Icon name="file" size={12} /> {t("Open local.toml")}
        </Button>
      }
    >
      {error && <p className="project-props-error">{error}</p>}
      {!error && targets.length === 0 && (
        <p className="project-props-note">{t("No run targets — install a loader SDK with Yog Installer, or name a loader checkout in local.toml ([sdk] loader).")}</p>
      )}
      {groups.map(([group, label]) => (
        <FormSection key={group} title={label}>
          {targets
            .filter((tg) => (tg.group ?? tg.name) === group)
            .map((tg) => (
              <TargetRow key={tg.name} target={tg} />
            ))}
        </FormSection>
      ))}
      <p className="project-props-note">
        {t("local.toml overrides the defaults on this machine: [sdk] loader (a checkout instead of the installed SDK), [java] (a JDK per Java version), [launch] env (e.g. the NVIDIA card), and [run.\"<id>\"] targets of its own.")}
      </p>
    </FormPage>
  );
}

function TargetRow({ target }: { target: RunTarget }) {
  return (
    <div className="project-props-preset">
      <div className="project-props-preset-main">
        <span className="project-props-preset-name">{target.variant ?? target.displayName ?? target.name}</span>
        <span className="project-props-preset-detail">yog run {target.name}</span>
      </div>
    </div>
  );
}
