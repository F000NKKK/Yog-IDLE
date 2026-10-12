import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, CommitTextField, FormField, FormPage, FormSection, useT } from "substrate-platform-ui";
import { errorText, projectApi } from "./api";
import { checkPlain } from "./ApplicationPages";
import type { PageProps } from "./ProjectPropertiesWindow";

interface PublishProfile {
  id: string;
  name: string;
  mode: "package" | "exports";
  dryRun: boolean;
}

/** Publish: the exports crate's license, and the saved publish profiles (edited and run in Build > Publish). */
export function PublishPage({ root, props, apply, onOpenPublish }: PageProps & { onOpenPublish: () => void }) {
  const t = useT();
  const [profiles, setProfiles] = useState<PublishProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<PublishProfile[]>("publish_profiles_list", { projectRoot: root })
      .then(setProfiles)
      .catch((err) => setError(errorText(err)));
  }, [root]);

  return (
    <FormPage title={t("Publish")} description={t("Packaging the mod as .yog, and publishing its exports crate so other mods can depend on it.")}>
      <FormSection title={t("Exports crate")}>
        <FormField
          label={t("Exports license")}
          hint={t("The license of the generated <mod>_exports crate on crates.io — empty: the mod's own license.")}
        >
          <CommitTextField
            value={props.manifest.fields.exports_license ?? ""}
            monospace
            placeholder={props.manifest.fields.license}
            validate={(v) => {
              const e = checkPlain(v);
              return e ? t(e) : null;
            }}
            onCommit={(v) => apply(() => projectApi.setField(root, "exports_license", v.trim()))}
          />
        </FormField>
      </FormSection>
      <FormSection
        title={t("Publish profiles")}
        actions={<Button onClick={onOpenPublish}>{t("Publish...")}</Button>}
        description={t("Saved in .yog-idle/publish-profiles/ — create, edit and run them from Build > Publish.")}
      >
        {error && <p className="project-props-error">{error}</p>}
        {profiles?.length === 0 && <p className="project-props-note">{t("No publish profiles yet.")}</p>}
        {profiles?.map((p) => (
          <div key={p.id} className="project-props-preset">
            <div className="project-props-preset-main">
              <span className="project-props-preset-name">{p.name}</span>
              <span className="project-props-preset-detail">
                {p.mode === "package" ? t("Package as .yog") : t("Publish exports")}
                {p.dryRun ? ` · ${t("dry run")}` : ""}
              </span>
            </div>
          </div>
        ))}
      </FormSection>
    </FormPage>
  );
}
