import { CheckField, CommitTextField, FormField, FormPage, FormSection, SelectField, StringListField, useT } from "substrate-platform-ui";
import { useEnvironment } from "../environment/environmentStore";
import { PLATFORMS, projectApi } from "./api";
import type { PageProps } from "./ProjectPropertiesWindow";

const EDITIONS = ["", "2015", "2018", "2021", "2024"];

/** Mirrors `properties::check_plain` — yog reads yog.toml values verbatim. */
export function checkPlain(value: string): string | null {
  return /["\\\n\r]/.test(value) ? "Can't contain quotes, backslashes or line breaks (yog reads yog.toml values verbatim)." : null;
}

/** Application: the `[mod]` table — id, name, version, description, authors, license, edition. */
export function ApplicationPage({ root, props, apply }: PageProps) {
  const t = useT();
  const fields = props.manifest.fields;
  const set = (key: string) => (value: string) => apply(() => projectApi.setField(root, key, value.trim()));
  const plain = (value: string) => {
    const error = checkPlain(value);
    return error ? t(error) : null;
  };

  return (
    <FormPage
      title={t("Application")}
      description={t("What the mod is called and who made it — the [mod] table of yog.toml.")}
    >
      <FormSection title={t("Identity")}>
        <FormField label={t("Mod ID")} required hint={t("Lowercase letters, digits, '-' and '_'. Other mods depend on it by this id.")}>
          <CommitTextField
            value={fields.id ?? ""}
            monospace
            validate={(v) => (!v.trim() ? t("A mod needs an id.") : /^[a-z0-9_-]+$/.test(v.trim()) ? null : t("Use lowercase letters, digits, '-' and '_' only."))}
            onCommit={set("id")}
          />
        </FormField>
        <FormField label={t("Display name")} required>
          <CommitTextField value={fields.name ?? ""} validate={(v) => (!v.trim() ? t("A mod needs a name.") : plain(v))} onCommit={set("name")} />
        </FormField>
        <FormField label={t("Version")} required hint={t("Semantic version, e.g. 1.2.3.")}>
          <CommitTextField
            value={fields.version ?? ""}
            monospace
            validate={(v) => (/^\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]+)?$/.test(v.trim()) ? null : t("Not a version like 1.2.3 (semver)."))}
            onCommit={set("version")}
          />
        </FormField>
        <FormField label={t("Description")}>
          <CommitTextField value={fields.description ?? ""} validate={(v) => plain(v.replace(/\n/g, " "))} onCommit={(v) => set("description")(v.replace(/\s*\n\s*/g, " "))} />
        </FormField>
        <FormField label={t("Authors")}>
          <StringListField
            value={props.manifest.authors}
            placeholder={t("Name")}
            addLabel={t("Add Author")}
            validateItem={(v) => (v.includes(",") ? t("An author's name can't contain a comma.") : plain(v))}
            onCommit={(authors) => apply(() => projectApi.setField(root, "authors", authors.map((a) => a.trim()).filter(Boolean)))}
          />
        </FormField>
      </FormSection>

      <FormSection title={t("Legal")}>
        <FormField label={t("License")} hint={t("An SPDX expression, e.g. MIT OR Apache-2.0.")}>
          <CommitTextField value={fields.license ?? ""} monospace validate={plain} onCommit={set("license")} />
        </FormField>
      </FormSection>

      <FormSection title={t("Rust")}>
        <FormField label={t("Edition")} hint={t("The Rust edition the mod's code is compiled with — empty: yog's default.")}>
          <SelectField
            value={fields.edition ?? ""}
            options={EDITIONS.map((e) => ({ value: e, label: e || t("Default") }))}
            aria-label={t("Edition")}
            onChange={(edition) => void apply(() => projectApi.setField(root, "edition", edition))}
          />
        </FormField>
      </FormSection>
    </FormPage>
  );
}

/** Build: which yog-api the mod builds against, and for which platforms. */
export function BuildPage({ root, props, apply }: PageProps) {
  const t = useT();
  const env = useEnvironment();
  const host = env.report?.hostTag ?? null;
  const targets = props.buildTargets;
  const all = targets.length === 0;

  function toggle(tag: string, on: boolean) {
    const current = all ? PLATFORMS.map((p) => p.tag) : targets;
    const next = PLATFORMS.map((p) => p.tag).filter((p) => (p === tag ? on : current.includes(p)));
    if (next.length === 0) return;
    // Every platform checked is the default — stored as "nothing chosen".
    void apply(() => projectApi.setBuildTargets(root, next.length === PLATFORMS.length ? [] : next));
  }

  return (
    <FormPage title={t("Build")} description={t("How Build (yog build) compiles this mod.")}>
      <FormSection title="yog-api">
        <FormField label={t("yog-api version")} hint={t("The API crate version the mod is built against, from crates.io. Mods must match the loader they run in.")}>
          <CommitTextField
            value={props.yogApiVersion ?? ""}
            monospace
            placeholder={t("Latest")}
            validate={(v) => (v.trim() && !/^[\^~=<>*]?\s*\d+(\.\d+){0,2}(\.\*)?$/.test(v.trim()) ? t("Not a version requirement like 0.30 or =0.30.1.") : null)}
            onCommit={(v) => apply(() => projectApi.setYogApi(root, "version", v.trim()))}
          />
        </FormField>
        <FormField
          label={t("Local yog-api crate")}
          hint={t("[dev] yog_api_path — build against a yog-api checkout instead of crates.io (for loader development). Tools > Options > Environment can set this for every project.")}
        >
          <CommitTextField
            value={props.manifest.yogApiPath ?? ""}
            monospace
            placeholder="crates.io"
            validate={(v) => {
              const error = checkPlain(v);
              return error ? t(error) : null;
            }}
            onCommit={(v) => apply(() => projectApi.setYogApi(root, "path", v.trim()))}
          />
        </FormField>
      </FormSection>

      <FormSection
        title={t("Platforms")}
        description={t("A .yog bundles a native library per platform. Building fewer is faster, but the mod then only loads on those. Saved for this project in .yog-idle/ (YOG_TARGETS); with all of them checked, the Environment option \"Build for this platform only\" decides.")}
      >
        {PLATFORMS.map((p) => (
          <CheckField
            key={p.tag}
            checked={all || targets.includes(p.tag)}
            onChange={(on) => toggle(p.tag, on)}
            label={p.tag === host ? t("{platform} (this computer)", { platform: p.label }) : p.label}
          />
        ))}
      </FormSection>
    </FormPage>
  );
}
