import { useEffect, useState } from "react";
import {
  Button,
  CommitTextField,
  FormField,
  FormPage,
  FormSection,
  Icon,
  SelectField,
  StringListField,
  Tab,
  confirmDialog,
  messageDialog,
  promptDialog,
  useT,
} from "substrate-platform-ui";
import { useEnvironment } from "../environment/environmentStore";
import { errorText, projectApi, type RunPreset, type RunTarget } from "./api";
import { checkPlain } from "./ApplicationPages";
import type { PageProps } from "./ProjectPropertiesWindow";

const ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Debug: the `[run.<id>]` targets the Run toolbar offers — each builds the
 * mod, copies the .yog into `export_dir` and runs `command` (normally the
 * loader's Gradle dev client). New ones come from the loader checkout's
 * versions, with JAVA_HOME from Tools > Options > Environment.
 */
export function DebugPage({ root, props, apply }: PageProps) {
  const t = useT();
  const targets = props.runTargets;
  const [selectedId, setSelectedId] = useState<string | null>(targets[0]?.id ?? null);
  const [adding, setAdding] = useState(false);
  const selected = targets.find((r) => r.id === selectedId) ?? targets[0] ?? null;

  async function addTarget(target: RunTarget) {
    const error = await apply(() => projectApi.setRunTarget(root, null, target));
    if (error) {
      await messageDialog({ title: t("Add Run Target"), message: error });
      return;
    }
    setSelectedId(target.id);
    setAdding(false);
  }

  async function addEmpty() {
    const id = await promptDialog({
      title: t("New Run Target"),
      label: t("Id (what yog run takes)"),
      confirmLabel: t("Add"),
      validate: (v) => (!v.trim() ? "" : ID_PATTERN.test(v.trim()) ? (targets.some((r) => r.id === v.trim()) ? t("[run.{id}] already exists.", { id: v.trim() }) : null) : t("Use letters, digits, '-', '_' and '.' only.")),
    });
    if (id === null) return;
    await addTarget({ id: id.trim(), name: id.trim(), exportDir: "", command: "", args: [], cwd: "", env: [] });
  }

  async function remove(target: RunTarget) {
    const confirmed = await confirmDialog({
      title: t("Remove Run Target"),
      message: t("Remove [run.{id}] from yog.toml?", { id: target.id }),
      confirmLabel: t("Remove"),
    });
    if (confirmed) await apply(() => projectApi.removeRunTarget(root, target.id));
  }

  return (
    <FormPage
      title={t("Debug")}
      description={t("Run targets — what Start (F5) and Start Without Debugging launch. Each builds the mod, copies the .yog into its export folder and runs its command.")}
      actions={
        <>
          <Button onClick={() => setAdding((a) => !a)}>
            <Icon name="plus" size={12} /> {t("Add Run Target...")}
          </Button>
          <Button disabled={!selected} onClick={() => selected && void remove(selected)}>
            <Icon name="trash" size={12} /> {t("Remove")}
          </Button>
        </>
      }
    >
      {adding && <AddTargetPanel root={root} existing={targets} onAdd={(target) => void addTarget(target)} onAddEmpty={() => void addEmpty()} />}
      {targets.length === 0 ? (
        <p className="project-props-note">{t("No run targets yet — add one for the loader and Minecraft version to test in.")}</p>
      ) : (
        <div className="project-props-split">
          <div className="project-props-list" role="listbox" aria-label={t("Run targets")}>
            {targets.map((r) => (
              <Tab key={r.id} orientation="list" active={r.id === selected?.id} onClick={() => setSelectedId(r.id)}>
                {r.name || r.id}
              </Tab>
            ))}
          </div>
          {selected && (
            <RunTargetEditor
              key={selected.id}
              target={selected}
              others={targets.filter((r) => r !== selected)}
              onChange={async (next) => {
                const error = await apply(() => projectApi.setRunTarget(root, selected.id, next));
                if (!error) setSelectedId(next.id);
                return error;
              }}
            />
          )}
        </div>
      )}
    </FormPage>
  );
}

/** The loader checkout's loader × Minecraft versions, plus an empty target. */
function AddTargetPanel({ root, existing, onAdd, onAddEmpty }: { root: string; existing: RunTarget[]; onAdd: (target: RunTarget) => void; onAddEmpty: () => void }) {
  const t = useT();
  const [presets, setPresets] = useState<RunPreset[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    projectApi
      .runPresets(root)
      .then(setPresets)
      .catch((err) => setError(errorText(err)));
  }, [root]);

  return (
    <div className="project-props-panel">
      {error && <p className="project-props-error">{error}</p>}
      {presets === null && !error && <p className="project-props-note">{t("Looking for the Yog Mod Loader checkout…")}</p>}
      {presets?.length === 0 && (
        <p className="project-props-note">{t("No Yog Mod Loader checkout found — install it from Tools > Install Components, or set its folder in Tools > Options > Environment.")}</p>
      )}
      {presets?.map(({ javaMajor, javaMissing, ...target }) => {
        const taken = existing.some((r) => r.id === target.id);
        return (
          <div key={target.id} className="project-props-preset">
            <div className="project-props-preset-main">
              <span className="project-props-preset-name">{target.name}</span>
              <span className="project-props-preset-detail">
                {target.cwd}
                {javaMajor != null && (javaMissing ? ` · ${t("needs JDK {major} — not installed", { major: javaMajor })}` : ` · JDK ${javaMajor}`)}
              </span>
            </div>
            <Button disabled={taken} onClick={() => onAdd(target)}>
              {taken ? t("Added") : t("Add")}
            </Button>
          </div>
        );
      })}
      <div className="project-props-preset">
        <div className="project-props-preset-main">
          <span className="project-props-preset-name">{t("Empty Target")}</span>
          <span className="project-props-preset-detail">{t("Any command — fill in the fields yourself.")}</span>
        </div>
        <Button onClick={onAddEmpty}>{t("Add...")}</Button>
      </div>
    </div>
  );
}

function RunTargetEditor({ target, others, onChange }: { target: RunTarget; others: RunTarget[]; onChange: (next: RunTarget) => Promise<string | void | null | undefined> }) {
  const t = useT();
  const env = useEnvironment();
  const plain = (v: string) => {
    const error = checkPlain(v);
    return error ? t(error) : null;
  };
  const item = (v: string) => (v.includes(",") ? t("List items can't contain commas (yog splits on them).") : plain(v));
  const javaHome = target.env.find((e) => e.startsWith("JAVA_HOME="))?.slice("JAVA_HOME=".length) ?? "";
  const jdks = env.report?.jdks ?? [];

  return (
    <div className="project-props-editor">
      <FormSection title={t("Target")}>
        <FormField label={t("Id")} required hint={t("yog run {id}", { id: target.id })}>
          <CommitTextField
            value={target.id}
            monospace
            validate={(v) =>
              !ID_PATTERN.test(v.trim()) ? t("Use letters, digits, '-' and '_' only.") : others.some((r) => r.id === v.trim()) ? t("[run.{id}] already exists.", { id: v.trim() }) : null
            }
            onCommit={(id) => onChange({ ...target, id: id.trim() })}
          />
        </FormField>
        <FormField label={t("Display name")} hint={t("Shown in the Run toolbar.")}>
          <CommitTextField value={target.name} validate={plain} onCommit={(name) => onChange({ ...target, name: name.trim() })} />
        </FormField>
      </FormSection>
      <FormSection title={t("Launch")}>
        <FormField label={t("Export folder")} hint={t("Where the built .yog is copied before the command runs — relative to the project.")}>
          <CommitTextField value={target.exportDir} monospace validate={plain} onCommit={(exportDir) => onChange({ ...target, exportDir: exportDir.trim() })} />
        </FormField>
        <FormField label={t("Command")}>
          <CommitTextField value={target.command} monospace placeholder="./gradlew" validate={plain} onCommit={(command) => onChange({ ...target, command: command.trim() })} />
        </FormField>
        <FormField label={t("Arguments")}>
          <StringListField value={target.args} monospace validateItem={item} addLabel={t("Add Argument")} onCommit={(args) => onChange({ ...target, args })} />
        </FormField>
        <FormField label={t("Working directory")}>
          <CommitTextField value={target.cwd} monospace validate={plain} onCommit={(cwd) => onChange({ ...target, cwd: cwd.trim() })} />
        </FormField>
      </FormSection>
      <FormSection title={t("Environment")}>
        <FormField label="JAVA_HOME" hint={t("The JDK the command runs with — the loader's Gradle build needs the Java version of its Minecraft version.")}>
          <SelectField
            value={javaHome}
            aria-label="JAVA_HOME"
            options={[
              { value: "", label: t("Not set (system default)") },
              ...jdks.map((j) => ({ value: j.home, label: `JDK ${j.major} — ${j.version} (${j.home})` })),
              ...(javaHome && !jdks.some((j) => j.home === javaHome) ? [{ value: javaHome, label: javaHome }] : []),
            ]}
            onChange={(home) => {
              const rest = target.env.filter((e) => !e.startsWith("JAVA_HOME="));
              void onChange({ ...target, env: home ? [`JAVA_HOME=${home}`, ...rest] : rest });
            }}
          />
        </FormField>
        <FormField label={t("Variables")} hint={t("KEY=VALUE, one per line.")}>
          <StringListField
            value={target.env}
            monospace
            placeholder="KEY=VALUE"
            addLabel={t("Add Variable")}
            validateItem={(v) => (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v.trim()) ? item(v) : t("\"{entry}\" isn't KEY=VALUE.", { entry: v.trim() }))}
            onCommit={(entries) => onChange({ ...target, env: entries.map((e) => e.trim()) })}
          />
        </FormField>
      </FormSection>
    </div>
  );
}
