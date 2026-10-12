import { useEffect, useState } from "react";
import { CheckField, CommitTextField, FormField, FormPage, FormSection, SelectField, useT } from "substrate-platform-ui";
import { gitApi, type GlobalConfig } from "./gitApi";
import { refreshGit } from "./gitStore";

/** Options > Source Control — Visual Studio's Git Global Settings, written to the user's global `.gitconfig`. */
export function GitSettingsPage() {
  const t = useT();
  const [config, setConfig] = useState<GlobalConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    gitApi
      .configGet()
      .then(setConfig)
      .catch((err) => setError(t(String(err))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(key: string, value: string): Promise<string | null> {
    try {
      await gitApi.configSet(key, value);
      setConfig((prev) => (prev ? { ...prev, values: { ...prev.values, [key]: value } } : prev));
      if (key === "user.name" || key === "user.email") void refreshGit();
      return null;
    } catch (err) {
      return t(String(err));
    }
  }

  if (error) return <FormPage title={t("Source Control")} description={error}>{null}</FormPage>;
  if (!config) return <FormPage title={t("Source Control")}>{t("Loading…")}</FormPage>;

  const values = config.values;
  const description = config.version
    ? t("Git {version}. These settings apply to every repository (your global .gitconfig).", { version: config.version.replace(/^git version\s*/i, "") })
    : t("Git isn't installed, or isn't on PATH.");
  const pullRebase = values["pull.rebase"] === "true" ? "true" : values["pull.rebase"] === "false" ? "false" : "";
  return (
    <FormPage title={t("Source Control")} description={description}>
      <FormSection title={t("Git Global Settings")}>
        <FormField label={t("User name")} hint={t("Recorded as the author of your commits.")}>
          <CommitTextField value={values["user.name"] ?? ""} onCommit={(v) => save("user.name", v.trim())} disabled={!config.version} />
        </FormField>
        <FormField label={t("Email")}>
          <CommitTextField value={values["user.email"] ?? ""} onCommit={(v) => save("user.email", v.trim())} disabled={!config.version} />
        </FormField>
        <FormField label={t("Default branch name")} hint={t("For new repositories (init.defaultBranch).")}>
          <CommitTextField value={values["init.defaultBranch"] ?? ""} placeholder="master" onCommit={(v) => save("init.defaultBranch", v.trim())} disabled={!config.version} />
        </FormField>
        <FormField label={t("Rebase local branch when pulling")}>
          <SelectField
            value={pullRebase}
            disabled={!config.version}
            options={[
              { value: "", label: t("Unset") },
              { value: "true", label: t("True") },
              { value: "false", label: t("False") },
            ]}
            onChange={(v) => void save("pull.rebase", v)}
          />
        </FormField>
        <FormField label="">
          <CheckField
            checked={values["fetch.prune"] === "true"}
            disabled={!config.version}
            label={t("Prune remote branches during fetch")}
            onChange={(checked) => void save("fetch.prune", checked ? "true" : "")}
          />
        </FormField>
      </FormSection>
    </FormPage>
  );
}

/** The Source Control page's labels — for Options' search. */
export const gitSettingsKeywords = ["Git", "user.name", "user.email", "User name", "Email", "Default branch name", "Rebase local branch when pulling", "Prune remote branches during fetch"];
