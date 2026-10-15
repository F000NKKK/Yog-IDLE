import { useEffect, useRef, useState } from "react";
import {
  Button,
  CheckField,
  CommitTextField,
  FormField,
  FormPage,
  FormSection,
  Icon,
  IconButton,
  StringListField,
  TextField,
  confirmDialog,
  messageDialog,
  useT,
  Spacer,
} from "substrate-platform-ui";
import { emptyDependency, errorText, projectApi, type CrateHit, type Dependency } from "./api";
import { checkPlain } from "./ApplicationPages";
import type { PageProps } from "./ProjectPropertiesWindow";

/**
 * Dependencies: Rust crates (`[dependencies]`) and other Yog mods
 * (`[dependencies.exports]` — their generated exports crates), each
 * editable in place, added by searching crates.io (NuGet-style).
 */
export function DependenciesPage({ root, props, apply }: PageProps) {
  const t = useT();
  const [searchFor, setSearchFor] = useState<boolean | null>(null);

  return (
    <FormPage title={t("Dependencies")} description={t("Crates and Yog mods this mod builds against. The yog-api version is on the Build page.")}>
      <DependencySection
        title={t("Mod Dependencies")}
        description={t("Other Yog mods whose exported API this one calls — [dependencies.exports], resolved to their <mod>_exports crates.")}
        mods
        deps={props.modDependencies}
        root={root}
        apply={apply}
        searching={searchFor === true}
        onSearch={() => setSearchFor((s) => (s === true ? null : true))}
      />
      <DependencySection
        title={t("Crate Dependencies")}
        description={t("Rust crates from crates.io (or a path / git repository) — [dependencies].")}
        mods={false}
        deps={props.dependencies}
        root={root}
        apply={apply}
        searching={searchFor === false}
        onSearch={() => setSearchFor((s) => (s === false ? null : false))}
      />
    </FormPage>
  );
}

function DependencySection({
  title,
  description,
  mods,
  deps,
  root,
  apply,
  searching,
  onSearch,
}: {
  title: string;
  description: string;
  mods: boolean;
  deps: Dependency[];
  searching: boolean;
  onSearch: () => void;
} & Pick<PageProps, "root" | "apply">) {
  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);

  async function add(dep: Dependency): Promise<boolean> {
    const error = await apply(() => projectApi.setDependency(root, mods, null, dep));
    if (error) {
      await messageDialog({ title: t("Add Dependency"), message: error });
      return false;
    }
    return true;
  }

  async function remove(dep: Dependency) {
    const confirmed = await confirmDialog({
      title: t("Remove Dependency"),
      message: t("Remove {name} from yog.toml?", { name: dep.name }),
      confirmLabel: t("Remove"),
    });
    if (confirmed) await apply(() => projectApi.removeDependency(root, mods, dep.name));
  }

  return (
    <FormSection
      title={title}
      description={description}
      actions={
        <Button variant={searching ? "primary" : "subtle"} onClick={onSearch}>
          <Icon name="search" size={12} /> {t("Browse...")}
        </Button>
      }
    >
      {searching && <CrateSearch mods={mods} installed={deps.map((d) => d.name)} onAdd={(hit) => add({ ...emptyDependency(hit.name), version: hit.version })} />}
      {deps.length === 0 ? (
        <p className="project-props-note">{t("None.")}</p>
      ) : (
        <div className="project-props-deps">
          {deps.map((dep) => (
            <div key={dep.name} className="project-props-dep">
              <div className="project-props-dep-row">
                <span className="project-props-dep-name">{dep.name}</span>
                <span className="project-props-dep-version">{describe(dep, t)}</span>
                <Spacer />
                <IconButton title={t("Edit")} aria-label={t("Edit")} onClick={() => setEditing((e) => (e === dep.name ? null : dep.name))}>
                  <Icon name="settings" />
                </IconButton>
                <IconButton title={t("Remove")} aria-label={t("Remove")} onClick={() => void remove(dep)}>
                  <Icon name="trash" />
                </IconButton>
              </div>
              {editing === dep.name && (
                <DependencyEditor
                  dep={dep}
                  mods={mods}
                  onChange={async (next) => {
                    const error = await apply(() => projectApi.setDependency(root, mods, dep.name, next));
                    if (!error && next.name !== dep.name) setEditing(next.name);
                    return error;
                  }}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </FormSection>
  );
}

function describe(dep: Dependency, t: ReturnType<typeof useT>): string {
  const parts: string[] = [];
  if (dep.version) parts.push(dep.version);
  if (dep.path) parts.push(t("path: {path}", { path: dep.path }));
  if (dep.git) parts.push(t("git: {url}", { url: dep.git }));
  if (dep.features.length > 0) parts.push(t("features: {list}", { list: dep.features.join(", ") }));
  if (!dep.defaultFeatures) parts.push(t("no default features"));
  if (dep.optional) parts.push(t("optional"));
  return parts.join(" · ");
}

function DependencyEditor({ dep, mods, onChange }: { dep: Dependency; mods: boolean; onChange: (next: Dependency) => Promise<string | void | null | undefined> }) {
  const t = useT();
  const plain = (v: string) => {
    const error = checkPlain(v);
    return error ? t(error) : null;
  };
  const [checkError, setCheckError] = useState<string | null>(null);
  const toggle = async (patch: Partial<Dependency>) => setCheckError((await onChange({ ...dep, ...patch })) || null);

  return (
    <div className="project-props-dep-editor">
      <FormField label={mods ? t("Mod ID") : t("Crate")}>
        <CommitTextField value={dep.name} monospace validate={(v) => (/^[A-Za-z0-9_-]+$/.test(v.trim()) ? null : t("Use letters, digits, '-' and '_' only."))} onCommit={(name) => onChange({ ...dep, name: name.trim() })} />
      </FormField>
      <FormField label={t("Version")} hint={t("A requirement like 1.0, ^0.4 or =2.1.3 — empty with a path or git source.")}>
        <CommitTextField value={dep.version} monospace validate={plain} onCommit={(version) => onChange({ ...dep, version: version.trim() })} />
      </FormField>
      <FormField label={t("Features")}>
        <StringListField value={dep.features} monospace addLabel={t("Add Feature")} validateItem={plain} onCommit={(features) => onChange({ ...dep, features: features.map((f) => f.trim()) })} />
      </FormField>
      <FormField label={t("Options")} error={checkError}>
        <CheckField checked={dep.defaultFeatures} onChange={(defaultFeatures) => void toggle({ defaultFeatures })} label={t("Default features")} />
        <CheckField checked={dep.optional} onChange={(optional) => void toggle({ optional })} label={t("Optional")} />
      </FormField>
      <FormField label={t("Local path")}>
        <CommitTextField value={dep.path} monospace validate={plain} onCommit={(path) => onChange({ ...dep, path: path.trim() })} />
      </FormField>
      <FormField label={t("Git repository")}>
        <CommitTextField value={dep.git} monospace validate={plain} onCommit={(git) => onChange({ ...dep, git: git.trim() })} />
      </FormField>
      {dep.otherKeys.length > 0 && (
        <p className="project-props-note">{t("Also set in yog.toml (kept as written): {keys}", { keys: dep.otherKeys.join(", ") })}</p>
      )}
    </div>
  );
}

/** crates.io search — for mods, only Yog exports crates (`<mod>_exports`). */
function CrateSearch({ mods, installed, onAdd }: { mods: boolean; installed: string[]; onAdd: (hit: CrateHit) => Promise<boolean> }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CrateHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      seq.current++;
      setBusy(false);
      setHits(null);
      setError(null);
      return;
    }
    const id = ++seq.current;
    const timer = setTimeout(() => {
      setBusy(true);
      projectApi
        .searchCrates(q, mods)
        .then((result) => {
          if (id !== seq.current) return;
          setHits(result);
          setError(null);
        })
        .catch((err) => id === seq.current && setError(errorText(err)))
        .finally(() => id === seq.current && setBusy(false));
    }, 350);
    return () => clearTimeout(timer);
  }, [query, mods]);

  return (
    <div className="project-props-panel">
      <TextField autoFocus placeholder={mods ? t("Search Yog mods on crates.io") : t("Search crates.io")} value={query} onChange={(e) => setQuery(e.target.value)} />
      {busy && <p className="project-props-note">{t("Searching…")}</p>}
      {error && <p className="project-props-error">{error}</p>}
      {hits?.length === 0 && !busy && <p className="project-props-note">{t("No results found.")}</p>}
      {hits?.map((hit) => {
        const added = installed.includes(hit.name);
        return (
          <div key={hit.crateName} className="project-props-preset">
            <div className="project-props-preset-main">
              <span className="project-props-preset-name">
                {hit.name} <span className="project-props-dep-version">{hit.version}</span>
                {hit.crateName !== hit.name && <span className="project-props-preset-detail"> ({hit.crateName})</span>}
              </span>
              <span className="project-props-preset-detail">{hit.description}</span>
              <span className="project-props-preset-detail">{t("{count} downloads", { count: hit.downloads.toLocaleString() })}</span>
            </div>
            <Button disabled={added} onClick={() => void onAdd(hit)}>
              {added ? t("Added") : t("Add")}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
