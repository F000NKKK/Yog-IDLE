# IDE boilerplate reduction

Status: proposal (nothing implemented). Scope: the Yog-IDLE front-end (`src/`), its Tauri
backend (`src-tauri/src/`), and the generic infrastructure it would need in
Substrate-Platform (`ui/` and the `substrate-platform` crate).

Ground rules this design follows:

- **Substrate stays generic.** Form/schema machinery, the command registry, stores,
  async hooks, error reporting and window hosting go to Substrate. Anything that knows
  about `yog.toml`, mods, run targets, Git config keys or `.yres` stays in Yog-IDLE.
- **No backward compatibility.** Every migrated page/menu/API deletes its old code in
  the same change. No shims, no aliases (`requestOpenFile = openFile` included).
- **Behaviour stays.** Commit-on-Enter/blur, "the backend re-reads and returns the new
  state", rejected values staying in the field with their message, VS-style labels: all
  of it is kept. Only how it is spelled changes.

Line numbers are as of Yog-IDLE commit `afed408`. Line counts are from `wc -l`;
"saved" estimates are net (new shared code subtracted) and deliberately rounded down.

---

## Summary (ranked)

| # | Finding | Sites | Est. lines saved | Where the fix lives |
|---|---|---|---|---|
| 1 | Hand-written form pages: `FormField` + `CommitTextField` + `validate` + `onCommit` + `.trim()` per field | 9 pages, ~70 fields | **650–750** | Substrate `SchemaForm` + Yog schemas |
| 2 | The same `yog.toml` `[mod]` fields defined twice (Properties tool window + Application page), with two backends (`mod_manifest_*` and `project_properties_*`) | 2 UIs, 2 Rust paths | **250** (TS 120 + Rust 130) | One schema → form *and* `PropertyGrid` |
| 3 | TS mirrors of Rust structs + stringly `invoke("name", {...})` wrappers | 97 `invoke` sites, ~40 mirrored interfaces, 66 `Serialize` structs | **350** + compile-time checking | `tauri-specta` generated bindings |
| 4 | Commands declared 2–4 times (menu entry, toolbar item, keybinding, panel button), shortcut strings duplicated | 58 `useKeybinding`, 51 hard-coded `shortcut:` strings, 3 item shapes | **250** + no drift | Substrate command registry |
| 5 | Load/error/cancel glue: `useState(null)` ×2 + `useEffect` + `cancelled` flag + `.catch(setError)` + eslint-disable | ~20 sites (10 `cancelled`, 14 `error` states, 27 `exhaustive-deps` disables) | **200** | Substrate `useResource` / `useLatest` |
| 6 | Module-level store/bus re-implemented: `let state; const subscribers = new Set(); notify; useSyncExternalStore(...)` | 14 copies | **130** | Substrate `createStore` / `createSignal` |
| 7 | Property-descriptor helper sets re-invented per editor (`num/text/choice/flag/vec` in ContentEditor, `text()` in Properties, `AttrKind` mapping in the designer) | 3 families | **150** | Substrate `prop.*` builders + lenses |
| 8 | Rust command shell: `PathBuf::from` + `validate_within_roots` + `spawn_blocking(...).await.map_err(...)?` | 45 + 17 sites | **180** (Rust) | `Scoped<PathBuf>` extractor + `blocking()` |
| 9 | Ad-hoc window opening: per-window `useState` in `App`, listener-set "buses", callbacks drilled through `Shell → ShellChrome → Menu` | 5 windows, 2 buses, 33 drilled props | **120** | Substrate `defineWindow` / `WindowHost` |
| 10 | Error text/reporting spelled 5 different ways | 23 `reportError(t("…: {error}", {error: String(err)}))`, 52 `String(err)` | **60** + consistency | Substrate `errorMessage` / `reportError(what, err)` |
| 11 | Tauri event subscriptions: `const unlistens = [listen(...)]; return () => unlistens.forEach(p => p.then(f => f()))` | 31 `listen` sites in 7 files | **60** | Substrate `useEvents` (typed by #3) |
| 12 | i18n side-plumbing: hand-kept `*Keywords` arrays, "English; shown through `t`" tables, backend messages translated by exact-string match | 5 keyword arrays, ~10 tables | **40** | Derived from schemas/commands (#1, #4) |

**Total: roughly 2,400–2,600 lines** out of ~21.7k TS + ~15.2k Rust, but the bigger win
is that adding a setting becomes one line in a schema instead of ~8 lines of JSX + a
keyword entry + a Rust validator + a TS validator + a translated duplicate.

---

## 1. Hand-written form pages → schema-driven forms

### What it looks like today

Every field of every settings/property page is the same 5–9 lines:

`src/projectProperties/ApplicationPages.tsx:29-35`
```tsx
<FormField label={t("Mod ID")} required hint={t("Lowercase letters, digits, '-' and '_'. Other mods depend on it by this id.")}>
  <CommitTextField
    value={fields.id ?? ""}
    monospace
    validate={(v) => (!v.trim() ? t("A mod needs an id.") : /^[a-z0-9_-]+$/.test(v.trim()) ? null : t("Use lowercase letters, digits, '-' and '_' only."))}
    onCommit={set("id")}
  />
</FormField>
```

`src/git/GitSettings.tsx:42-50` — same shape, three times in a row, each with its own
`disabled={!config.version}` and `.trim()`:
```tsx
<FormField label={t("User name")} hint={t("Recorded as the author of your commits.")}>
  <CommitTextField value={values["user.name"] ?? ""} onCommit={(v) => save("user.name", v.trim())} disabled={!config.version} />
</FormField>
<FormField label={t("Email")}>
  <CommitTextField value={values["user.email"] ?? ""} onCommit={(v) => save("user.email", v.trim())} disabled={!config.version} />
</FormField>
```

The "plain value" validator is re-wrapped locally **five times**
(`ApplicationPages.tsx:18-21`, `:118-121`, `DebugPage.tsx:163-166`,
`DependenciesPage.tsx:154-157`, `PublishPage.tsx:38-41`):
```tsx
const plain = (v: string) => {
  const error = checkPlain(v);
  return error ? t(error) : null;
};
```

`RunTargetEditor` (`DebugPage.tsx:160-231`) and `DependencyEditor`
(`DependenciesPage.tsx:152-187`) are "edit one record of a list" forms where *every*
field repeats `onCommit={(x) => onChange({ ...target, x: x.trim() })}`.

Each page also has its own load/error/loading prologue (`GitSettings.tsx:8-32`,
`ProjectPropertiesWindow.tsx:47-73`, `PublishPage.tsx:17-24`), and pages that appear in
Options keep a hand-maintained search list that duplicates the labels
(`GitSettings.tsx:77`, `EnvironmentSettings.tsx:51-61`, Substrate's
`EditorSettings.tsx:9-17`).

Substrate's own pages don't even use the Form widgets: `EditorSettings.tsx` has a private
`NumberSetting` (lines 24-42) and raw `<Label>/<TextField>/<input type=checkbox>`.

| File | Lines | Fields |
|---|---|---|
| `src/git/GitSettings.tsx` | 77 | 5 |
| `src/projectProperties/ApplicationPages.tsx` | 142 | 9 + platform checklist |
| `src/projectProperties/DebugPage.tsx` | 231 | 8 per target + list master/detail |
| `src/projectProperties/DependenciesPage.tsx` | 249 | 7 per dep + 2 list sections |
| `src/projectProperties/PublishPage.tsx` | 67 | 1 + read-only list |
| `src/projectProperties/ProjectPropertiesWindow.tsx` | 110 | (host) |
| `src/environment/EnvironmentSettings.tsx` | 224 | 7 + per-JDK rows |
| `src/panels/PublishWindow.tsx` | 194 | buffered form, 3 fields |
| Substrate `pages/*Settings.tsx` | 245 | ~10 |
| **Total** | **~1,540** | |

### Proposed API (Substrate `ui/src/widgets/Form/schema.ts`)

The renderer stays the existing `FormPage`/`FormSection`/`FormField`/`CommitTextField`
(they are fine); the schema only removes the per-field wiring.

```ts
/** A message in English — translated by whoever shows it. `[text, params]` for placeholders. */
export type Msg = string | readonly [string, Record<string, string | number>];

/** Returns an English message (translated by the renderer), "" to block silently, or null. */
export type Validator<T> = (value: T) => Msg | "" | null;

export const v: {
  required(message: Msg): Validator<string>;
  pattern(re: RegExp, message: Msg): Validator<string>;
  range(min: number | undefined, max: number | undefined, opts?: { int?: boolean }): Validator<string>;
  noneOf(taken: () => readonly string[], message: (value: string) => Msg): Validator<string>;
  all<T>(...validators: Validator<T>[]): Validator<T>;
  each(item: Validator<string>): Validator<readonly string[]>;
};

interface FieldBase<V, T> {
  /** Stable id; also the default binding (`get = v => v[key]`, `set = value => ({ [key]: value })`). Dotted keys are fine. */
  key: string;
  label: string;                        // English
  hint?: Msg;
  required?: boolean;
  get?: (values: V) => T;
  /** What to commit. Default: `{ [key]: value }` merged into the source. */
  set?: (value: T, values: V) => Partial<V> | FieldWrite;
  validate?: Validator<T>;
  disabled?: (values: V) => boolean;
  visible?: (values: V) => boolean;
  /** Extra Options-search terms beyond the label/hint (config keys like `user.name`, synonyms like "Java"). */
  keywords?: string[];
}

export type FieldSpec<V> =
  | (FieldBase<V, string> & { kind: "text"; monospace?: boolean; multiline?: boolean; trim?: boolean /* default true */;
      placeholder?: Msg | ((values: V) => string | undefined) })
  | (FieldBase<V, string> & { kind: "path"; directory?: boolean; placeholder?: Msg | ((values: V) => string | undefined) })
  | (FieldBase<V, boolean> & { kind: "check"; /** For string-backed flags (git config): stored values for on/off. */ encode?: { on: string; off: string } })
  | (FieldBase<V, string> & { kind: "select"; options: readonly SelectOption[] | ((values: V) => readonly SelectOption[]) })
  | (FieldBase<V, readonly string[]> & { kind: "list"; addLabel?: string; placeholder?: string; monospace?: boolean; item?: Validator<string> })
  | (FieldBase<V, unknown> & { kind: "custom"; render: (ctx: FieldContext<V>) => ReactNode });

export interface SectionSpec<V> {
  title: string;
  description?: Msg;
  fields: FieldSpec<V>[];
  actions?: (ctx: FormContext<V>) => ReactNode;
  visible?: (values: V) => boolean;
}

export interface FormSchema<V> {
  title: string;
  description?: Msg | ((values: V) => Msg);
  sections: SectionSpec<V>[];
  /** Applied to every field (e.g. "git isn't installed"). */
  disabled?: (values: V) => boolean;
  /** Page-level extra search terms ("Git", "CARGO_HOME"). */
  keywords?: string[];
}

/** Where a form's values come from and where commits go. */
export interface FormSource<V> {
  values: V | undefined;
  loading: boolean;
  error: string | null;
  /** Resolves null on success, or the rejection (already a display string). */
  commit(field: FieldSpec<V>, patch: Partial<V> | FieldWrite): Promise<string | null>;
}

/** Immediate mode (property pages): each field commits on Enter/blur. */
export function SchemaForm<V>(props: { schema: FormSchema<V>; source: FormSource<V>; actions?: ReactNode }): JSX.Element;

/** Buffered mode (dialogs): edits stay in a draft until `submit`; tracks dirty + validity. */
export function useBufferedForm<V>(schema: FormSchema<V>, initial: V): {
  values: V; dirty: boolean; valid: boolean; errors: Record<string, string>;
  bind: FormSource<V>; reset(next?: V): void; submit(save: (values: V) => Promise<unknown>): Promise<boolean>;
};

/** Every label/hint/section title in English plus the schema's and fields' `keywords` — the Options search's `keywords`.
 *  Replaces hand-kept arrays; the explicit `keywords` keep today's non-label terms (`user.name`, "Java",
 *  "CARGO_HOME") searchable (capability rule). */
export function schemaKeywords(schema: FormSchema<unknown>): string[];

/** The same schema as PropertyGrid rows (see finding #2). */
export function schemaToProperties<V>(schema: FormSchema<V>, source: FormSource<V>, opts?: { category?: (section: SectionSpec<V>) => string }): PropertyDescriptor[];

/** A Settings window section built from a schema — `keywords` derived. */
export function schemaSection<V>(id: string, schema: FormSchema<V>, useSource: () => FormSource<V>): SettingsSection;
```

Field builders (sugar, same module) keep schemas one line per field:

```ts
export const f: {
  text<V>(key: string, label: string, opts?: Omit<Extract<FieldSpec<V>, { kind: "text" }>, "key" | "label" | "kind">): FieldSpec<V>;
  path<V>(...): FieldSpec<V>;
  check<V>(...): FieldSpec<V>;
  select<V>(key: string, label: string, options: ..., opts?): FieldSpec<V>;
  list<V>(...): FieldSpec<V>;
  custom<V>(...): FieldSpec<V>;
};
```

Sources (Substrate):

```ts
/** A value in the app's StateStore (state.json), defaults merged in; `onChange` sees every write (e.g. push to the backend). */
export function useStoredSource<V extends object>(key: string, defaults: V, opts?: { onChange?: (next: V) => void | Promise<void> }): FormSource<V>;

/** Load once (re-load on `deps`), commit through `write`, which resolves the new full value (the "re-read and return" pattern yog.toml uses). */
export function useRemoteSource<V>(load: () => Promise<V>, write: (patch: Partial<V> | FieldWrite, field: FieldSpec<V>) => Promise<V | void>, deps: unknown[], opts?: { after?: (next: V) => void }): FormSource<V>;
```

### After — Git settings (Yog-IDLE)

```ts
// src/git/GitSettings.ts — replaces GitSettings.tsx (77 → ~30 lines)
const gitForm: FormSchema<GlobalConfig> = {
  title: "Source Control",
  description: (c) => c.version
    ? ["Git {version}. These settings apply to every repository (your global .gitconfig).", { version: c.version.replace(/^git version\s*/i, "") }]
    : "Git isn't installed, or isn't on PATH.",
  disabled: (c) => !c.version,
  sections: [{
    title: "Git Global Settings",
    fields: [
      f.text("user.name", "User name", { hint: "Recorded as the author of your commits." }),
      f.text("user.email", "Email"),
      f.text("init.defaultBranch", "Default branch name", { hint: "For new repositories (init.defaultBranch).", placeholder: "master" }),
      f.select("pull.rebase", "Rebase local branch when pulling", [{ value: "", label: "Unset" }, { value: "true", label: "True" }, { value: "false", label: "False" }]),
      f.check("fetch.prune", "Prune remote branches during fetch", { encode: { on: "true", off: "" } }),
    ].map(gitKey),          // get/set through config.values[key] + gitApi.configSet
  }],
};

export const gitSettingsSection = schemaSection("sourceControl", gitForm, () =>
  useRemoteSource(commands.gitConfigGet, ({ key, value }) => commands.gitConfigSet(key, value), [], {
    after: (_, field) => (field.key === "user.name" || field.key === "user.email") && void refreshGit(),
  }));
```

### After — Application page (Yog-IDLE)

```ts
// src/projectProperties/schemas.ts
const plain = v.pattern(/^[^"\\\n\r]*$/, "Can't contain quotes, backslashes or line breaks (yog reads yog.toml values verbatim).");
const modField = (key: string, label: string, o = {}) => f.text<ProjectProps>(key, label, { get: (p) => p.manifest.fields[key] ?? "", set: (value) => ({ op: "setField", key, value }), ...o });

export const applicationForm: FormSchema<ProjectProps> = {
  title: "Application",
  description: "What the mod is called and who made it — the [mod] table of yog.toml.",
  sections: [
    { title: "Identity", fields: [
      modField("id", "Mod ID", { required: true, monospace: true, hint: "Lowercase letters, digits, '-' and '_'. Other mods depend on it by this id.",
        validate: v.all(v.required("A mod needs an id."), v.pattern(/^[a-z0-9_-]+$/, "Use lowercase letters, digits, '-' and '_' only.")) }),
      modField("name", "Display name", { required: true, validate: v.all(v.required("A mod needs a name."), plain) }),
      modField("version", "Version", { required: true, monospace: true, hint: "Semantic version, e.g. 1.2.3.", validate: v.pattern(SEMVER, "Not a version like 1.2.3 (semver).") }),
      modField("description", "Description", { validate: plain }),
      f.list("authors", "Authors", { get: (p) => p.manifest.authors, addLabel: "Add Author", placeholder: "Name",
        item: v.all(v.pattern(/^[^,]*$/, "An author's name can't contain a comma."), plain) }),
    ]},
    { title: "Legal", fields: [modField("license", "License", { monospace: true, validate: plain, hint: "An SPDX expression, e.g. MIT OR Apache-2.0." })] },
    { title: "Rust", fields: [f.select("edition", "Edition", EDITIONS, { get: (p) => p.manifest.fields.edition ?? "", set: (value) => ({ op: "setField", key: "edition", value }) })] },
  ],
};
```

`ApplicationPage` (≈65 lines of JSX) becomes ≈25 lines of schema. `RunTargetEditor` and
`DependencyEditor` become `FormSchema<RunTarget>` / `FormSchema<Dependency>` rendered by a
generic **record-list** section (below), and the five `plain` wrappers disappear because
`Validator` messages are English and the renderer translates them once.

### Generic record-list section (Substrate)

`DebugPage` (targets: list on the left, editor on the right) and `DependenciesPage`
(rows with ⚙/🗑, inline editor) are the same thing: a keyed list of records, each edited
with a schema, add/remove with confirmation.

```ts
export interface RecordListProps<R> {
  items: readonly R[];
  keyOf: (item: R) => string;
  labelOf: (item: R) => string;
  detailOf?: (item: R) => string;
  schema: FormSchema<R>;
  /** Replace the record that was `originalKey` (null = add). Resolves the rejection message. */
  save: (originalKey: string | null, next: R) => Promise<string | null>;
  remove?: { confirm: (item: R) => Msg; run: (item: R) => Promise<string | null> };
  add?: { label: string; create: () => Promise<R | null> } | { label: string; panel: (close: () => void) => ReactNode };
  layout: "master-detail" | "inline";
  emptyText: Msg;
}
export function RecordList<R>(props: RecordListProps<R>): JSX.Element;
```

### Buffered mode — PublishWindow

`PublishWindow.tsx:36-89` keeps 5 `useState`s (`name`, `mode`, `dryRun`, `editingId`,
`error`) plus `resetForm()`/`editProfile()` that copy fields in and out by hand. With
`useBufferedForm(publishProfileSchema, empty)` that is `form.reset(profile)` /
`form.submit(save)`, and the radio list becomes `f.select(..., { variant: "radio" })`.
≈60 lines saved; the window keeps its own chrome.

### Estimate

~1,540 lines today → ~600 (schemas ~350, `RecordList` ~150, schema renderer ~200 in
Substrate, counted). **≈650–750 saved**, plus Substrate's own Settings pages migrate onto
the same thing.

### Decisions needed

- **D1 — client-side validators: keep, or rely on the backend?** The Rust side already
  validates every `yog.toml` write with the *same English messages*
  (`properties.rs:201-220` `check_field` vs `ApplicationPages.tsx:29-46`). Option A (keep
  both, schema validators mirror Rust): errors as you type. Option B (drop TS validators
  for backend-validated fields): an invalid value is rejected on Enter/blur with the
  backend's message, which `CommitTextField` already shows; ~60 more lines go, and the
  two can't drift. Recommendation: **B** for `yog.toml` fields, keep TS validators only
  where there's no backend check (dialogs, Git config).
- **D2 — Apply button vs immediate commit.** Current pages commit per field
  (VS 2022's new property pages do too). Proposal keeps immediate mode for property/
  options pages and uses buffered mode only for dialogs (Publish, New Item). If you want
  an "Apply/OK/Cancel" Options window, buffered mode supports it, but it's a UX change.

---

## 2. One `yog.toml` schema, two UIs, two backends

### Today

The Properties tool window re-declares the `[mod]` fields with its own builder, its own
descriptions, **no client validation**, and a *different* backend command pair:

`src/panels/Properties.tsx:352-397`
```ts
const text = (key: ManifestField, name: string, description: string): PropertyDescriptor => ({
  id: `mod.${key}`, name, category: t("Mod"), value: field(key), description,
  onCommit: (value) => update(key, String(value)),
});
return [
  text("id", t("Id"), t("The mod's unique id (lowercase letters, digits, '-' and '_'). …")),
  text("name", t("Name"), t("The mod's display name.")),
  ...
```
`src/panels/Properties.tsx:235` → `invoke<Manifest>("mod_manifest_set", …)`, while the
Application page goes through `project_properties_set_field`
(`src-tauri/src/lib.rs:205-222` vs `:237-247`). Rust keeps `ManifestOut` + `summarize`
+ `table_len` (`properties.rs:96-200`) only for this window; `project_properties::set_field`
already calls the same `set_manifest_field` and re-reads.

The Properties window also has its own `Manifest` TS interface (`Properties.tsx:22-31`),
a separate `ManifestField` union, and its own "don't write under a dirty yog.toml tab"
guard (`:231-234`) that the Project Properties window doesn't have.

### Proposal

- Delete `mod_manifest_read`, `mod_manifest_set`, `ManifestOut`, `summarize`,
  `table_len` and the TS `Manifest`. The Properties window reads `ProjectProps`
  (`project_properties_read`) — the counts it shows are `props.dependencies.length` etc.
- Render the mod rows with `schemaToProperties(applicationForm, source, { category: () => "Mod" })`.
  Field descriptions come from the schema `hint`s — one text per field, not two.
- Move the dirty-tab guard into the shared `projectSource` (`useRemoteSource` wrapper in
  Yog-IDLE), so both windows get it.

**Saved: ~120 TS (Properties.tsx 352-431 and the manifest plumbing), ~130 Rust.**

### Decision (decided 2026-10-13: as recommended)

- **D3** — Should the Properties tool window keep showing *editable* `[mod]` fields at
  all, or show read-only summary rows + an "Open Project Properties" `edit` (…) button on
  the category? VS shows project properties in the Properties window only as read-only
  identity rows. Either way it's one schema; read-only drops another ~20 lines. (Capability
  rule: with read-only rows, every field stays editable one click away in Project Properties,
  which already edits all of them.)

---

## 3. Hand-mirrored Rust types and stringly `invoke`

### Today

- 97 `invoke` call sites in 33 files; 13 of them live in two hand-written wrapper objects
  (`src/git/gitApi.ts:85-112` – 25 commands, `src/projectProperties/api.ts:74-87` – 10).
  The rest call `invoke<T>("snake_name", { camelArgs })` inline
  (`PublishWindow.tsx:51,81,94,105`, `Properties.tsx:131,136,235,311`,
  `PublishPage.tsx:23`, `App.tsx:236,242`, `ProjectExplorer.tsx:37-41,98,233,242,252,253,292,309,316`, …).
- TS interfaces that mirror Rust structs by hand, typically commented
  ``/** `project_properties::Dependency` */`` (`api.ts:4-44`), or redeclared in two
  places: `PublishProfile` is defined in both `PublishWindow.tsx:7-12` and
  `PublishPage.tsx:8-13`; `{ stage: string }` vs `GameStatusEvent` for the same event
  (`useModRunTargets.tsx:30`, `outputSource.tsx:74`, `useGameStatus.tsx:81`).
- 66 `#[derive(Serialize…)]` + 66 `#[serde(rename_all = "camelCase")]` on the Rust side,
  each with a TS twin that nothing checks.

### Proposal: generated bindings (`tauri-specta` v2 + `specta`)

```rust
// src-tauri/src/lib.rs
let builder = tauri_specta::Builder::<tauri::Wry>::new()
    .commands(tauri_specta::collect_commands![git::git_status, git::git_stage, /* … same list as invoke_handler … */])
    .events(tauri_specta::collect_events![GameStatus, WorkflowExit, HotReload, DebugStopped /* … */]);
#[cfg(debug_assertions)]
builder.export(specta_typescript::Typescript::default(), "../src/bindings.ts").expect("bindings");
tauri::Builder::default().invoke_handler(builder.invoke_handler()) /* replaces generate_handler![…] */
```
Each serialized type gets `#[derive(specta::Type)]` (one token added to existing derives).

```ts
// generated src/bindings.ts (checked in)
export const commands = {
  gitStatus(root: string): Promise<Result<RepoStatus | null, string>>,
  projectDependencySet(projectRoot: string, mods: boolean, original: string | null, dependency: Dependency): Promise<Result<ProjectProps, string>>,
  …
};
export const events = { gameStatus: __makeEvents__<GameStatus>("game-status"), … };
```

Then:
- `gitApi.ts` keeps only its pure helpers (`changeLetter`, `splitRepoPath` …): 161 → ~60.
- `projectProperties/api.ts`: 87 → ~15 (`PLATFORMS`, `emptyDependency`).
- All inline `interface X` that mirror Rust go (≈40 of the 146 interfaces).
- Renaming a Rust command or field is a TS compile error instead of a runtime "command
  not found".

Use `Result`-unwrapping mode (`specta` "throw" error handling) so call sites stay
`await commands.gitStatus(root)` and errors flow into `useResource`/`errorMessage` (#5, #10).

**Saved: ~350 lines; more importantly, removes a whole class of silent drift.**

### Decision (decided 2026-10-13: as recommended)

- **D4** — Accept `tauri-specta` (+ `specta`, `specta-typescript`) as dependencies of
  `yog-idle-tauri`? Alternative with zero new deps: a hand-kept `commands.ts` that at
  least centralizes every `invoke` (saves ~100 lines, no type checking). Recommendation:
  tauri-specta. Bindings are regenerated by the debug app at startup (or a
  `cargo test export_bindings`), and `src/bindings.ts` is committed.
- **D5** — Collapse the eight `project_*_set/remove` commands into one
  `project_edit(root, edit: ProjectEdit)` with a tagged enum
  (`SetField | SetYogApi | SetDependency | RemoveDependency | SetRunTarget | …`)? It
  removes ~80 Rust lines of identical command shells (`lib.rs:226-324`) and makes the
  form `set` return a typed `ProjectEdit`. Recommendation: yes; it fits the schema's
  `set → FieldWrite` slot exactly.

---

## 4. Commands declared 2–4 times

### Today

A single action is spelled in up to four places, with the shortcut string copied into
each and nothing tying them together:

| Action | Menu entry | Keybinding | Toolbar / panel |
|---|---|---|---|
| Step Over | `App.tsx:412` `{ label: t("Step Over"), shortcut: "F10", disabled: !paused, … }` | `DebugSessionContext.tsx:35` `useKeybinding("F10", …, { id: "debug.stepOver" })` | `DebugPanel.tsx:105` `title={withShortcut("Step Over", "F10")}` |
| Save All | `App.tsx:` FileMenu `shortcut: "Ctrl+Shift+S"` | `EditorActions.tsx:145` | `EditorActions.tsx:193` `withShortcut("Save All", "Ctrl+Shift+S")` |
| Find in Files | `EditorActions.tsx:167` | `search/SearchHost.tsx:15` | — |
| Git Changes | `git/GitMenu.tsx:48` `"Ctrl+0 Ctrl+G"` | `git/GitHost.tsx:58` | — |
| Manage Branches | `git/GitMenu.tsx:55` | `git/GitHost.tsx:59` | `git/GitChangesWindow.tsx:165` (context menu, 3rd copy of the string) |
| Build / Clean | `App.tsx:255-259` via `runModCommand` | — | `ProjectExplorer.tsx:433-436` — a second copy of `runModCommand` |

Counts: 58 `useKeybinding` calls, 51 literal `shortcut: "…"` strings. Substrate already
has `keybindingLabel(id)` and user overrides (`keys.tsx:233-241`), but menus never use
it, so **a user rebinding is not reflected in any menu**. There are also three item
shapes for the same concept: `MenuBarDropdownEntry` (`onClick`, `items`),
`ContextMenuItem` (`onSelect`, `submenu`), `ToolbarItem` (`icon`, `onClick`).

`ContentEditor.tsx:779-800` registers 20 keybindings, each with `{ when: editable }`, and
keeps a `commands` ref only to give `registerDocumentCommands` stable closures.

### Proposed API (Substrate `ui/src/infra/commands/`)

```ts
export interface CommandDef<A extends unknown[] = []> {
  id: string;                         // "debug.stepOver"
  label: string;                      // English; menus/tooltips translate
  icon?: string;
  keys?: string | string[];           // default shortcut(s); user keymap overrides by id
  /** Evaluated on render of any menu/toolbar showing it, and on key press. */
  enabled?: (...args: A) => boolean;
  checked?: (...args: A) => boolean;
  /** Returning `false` from a key press declines it (the key goes on to the next handler), as
   *  `useKeybinding` allows today; `ctx.event` is the `KeyboardEvent` when a key fired it (capability rule). */
  run: (...args: [...A, ctx?: { event?: KeyboardEvent }]) => void | boolean | Promise<unknown>;
  /** Key press only fires while this holds (focus scoping). */
  when?: () => boolean;
}

/** Registers for the component's lifetime (closures read live — no refs needed). */
export function useCommands(defs: CommandDef[]): void;
export function registerCommand(def: CommandDef): () => void;
export function runCommand(id: string, ...args: unknown[]): void;
// `useKeybinding`/`registerKeybinding` stay as the low-level path for keys that aren't commands
// (e.g. editor-internal chords with no menu entry); a binding with an `id` is still user-rebindable.

/** One entry type for menu bar, context menu and toolbar. */
export type MenuEntry =
  | { command: string; args?: unknown[]; label?: string /* override */ }
  | { label: string; items: MenuEntry[]; disabled?: boolean }
  | { label: ReactNode; run: () => void; icon?: string; shortcut?: string; disabled?: boolean; checked?: boolean; destructive?: boolean }   // ad-hoc (recent files)
  | "separator";
// Capability rule: the ad-hoc entry keeps everything the four old shapes allow — a ReactNode label
// (ContextMenuItem), an icon (ToolbarItem), a display-only shortcut hint, submenus. Tree menus take
// `(node) => MenuEntry[]`, so per-node actions keep TreeMenuItem's `onSelect(node)`; Toolbar keeps `leading`.

// MenuBarItem, ContextMenu, Toolbar all take MenuEntry[]; shortcut text, enabled state,
// icon and tooltip ("Step Over (F10)") come from the registry.
```

### After

```ts
// src/debugger/commands.ts
export function useDebugCommands() {
  const s = useDebugSessionContext();
  const paused = s.debugging && !!s.stopped && s.stopped.reason !== "exited";
  useCommands([
    { id: "debug.continue",  label: "Continue",       icon: "play",     keys: "F5",            enabled: () => paused, run: s.continue_ },
    { id: "debug.breakAll",  label: "Break All",      icon: "pause",    keys: "Ctrl+Alt+Break", enabled: () => s.debugging && !s.stopped, run: s.pause },
    { id: "debug.stepOver",  label: "Step Over",      icon: "stepOver", keys: "F10",           enabled: () => paused, run: () => s.step("over") },
    …
  ]);
}

// App.tsx
<MenuBarItem label="Debug" items={["debug.continue", "debug.breakAll", "separator", "debug.stepOver", "debug.stepInto", "debug.stepOut", "separator", "debug.restart", "debug.stop"].map(cmd)} />
// DebugPanel.tsx
<Toolbar sections={[["debug.continue", "debug.breakAll", "debug.stepOver", "debug.stepInto", "debug.stepOut"].map(cmd)]} />
```

`EditMenu` + `editorToolbarSections` + `EditorKeybindings` (`EditorActions.tsx:142-204`,
~60 lines) collapse into one `useCommands` list + two id arrays. `DebugMenu`,
`DebugPanel` buttons and `DebugSessionContext` bindings become one list.

**Saved: ~250 lines; menus show the user's real shortcuts; "Ctrl+0 Ctrl+R" exists once.**

### Decision (decided 2026-10-13: as recommended)

- **D6** — Unify `MenuBarDropdownEntry` / `ContextMenuItem` / `ToolbarItem` /
  `TreeMenuItem` into one `MenuEntry` (breaking change across Substrate, all call sites
  migrated in the same commit)? Recommendation: yes, per the no-backcompat rule.

---

## 5. Async load/error/cancel glue

### Today (≈20 sites)

`src/git/DiffDocument.tsx:21-41`
```tsx
const [texts, setTexts] = useState<DiffTexts | null>(null);
const [error, setError] = useState<string | null>(null);
useEffect(() => {
  if (!root) return;
  let cancelled = false;
  gitApi.diffTexts(root, request.left, request.right)
    .then((next) => { if (cancelled) return; setError(null); setTexts(…); })
    .catch((err) => !cancelled && setError(t(String(err))));
  return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [root, revision, request]);
```
Same shape: `GitSettings.tsx:9-18`, `GitRepositoryWindow.tsx:40-62`,
`ProjectPropertiesWindow.tsx:47-59`, `PublishPage.tsx:17-24`, `DebugPage.tsx:114-123`,
`PublishWindow.tsx:36-59`, `Properties.tsx:114-150`, `useModRunTargets.tsx:15-20`,
`RunToolbar.tsx:~40`, `ScreenDesigner.tsx:297,457`, `YresEditor.tsx`, `VariableWindows.tsx`.
Debounced + "latest request wins" variants with a manual `seq` ref:
`DependenciesPage.tsx:192-221` (CrateSearch) and `search/CodeSearch.tsx:66-110`.

Totals: 10 `let cancelled = false`, 14 `useState<string | null>(null)` error states,
27 `eslint-disable-next-line react-hooks/exhaustive-deps`.

### Proposed API (Substrate `ui/src/infra/hooks/useResource.ts`)

```ts
export interface Resource<T> {
  data: T | undefined;           // last good value (kept while reloading — no flash)
  error: string | null;          // errorMessage(err), translated
  loading: boolean;
  reload(): void;
  /** Optimistic/local replace (e.g. a write returned the new state). */
  set(next: T | ((prev: T | undefined) => T)): void;
}

/** Runs `load` when `deps` change (skipped while `load` is null), drops stale responses, keeps the previous data. */
export function useResource<T>(load: (() => Promise<T>) | null, deps: readonly unknown[], opts?: { debounceMs?: number; keepPrevious?: boolean }): Resource<T>;

/** For actions: `run` wraps a promise with busy + error state; errors also go to reportError unless `silent`. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>, opts?: { what?: Msg; silent?: boolean }): { run: (...args: A) => Promise<R | undefined>; busy: boolean; error: string | null };
```

### After

```tsx
const diff = useResource(root ? () => commands.gitDiffTexts(root, request.left, request.right) : null, [root, revision, request]);
```
```tsx
// CrateSearch: 30 lines of seq/timer/busy → 1
const hits = useResource(query.trim() ? () => commands.cratesSearch(query.trim(), mods) : null, [query, mods], { debounceMs: 350 });
```

**Saved: ~200 lines, and the 27 exhaustive-deps disables mostly go (deps are explicit).**

---

## 6. Fourteen hand-rolled module stores

### Today

Copies of the same 10–15 lines (`let state` + `Set` of subscribers + `notify` +
`useSyncExternalStore(subscribe, () => state)`):
`outputSource.tsx:32`, `search/findStore.ts:70`, `search/searchUi.ts:25`,
`designer/components.ts:60`, `designer/activeDesigner.ts:21`,
`designer/imageSources.ts:20`, `environment/environmentStore.ts:107`,
`git/BranchPicker.tsx:13`, `git/gitStore.ts:35`, `git/gitDocuments.tsx:34`,
`lang/designResources.ts:31`; and listener-only "buses":
`fileOpenBus.tsx:23`, `projectProperties/bus.ts:10`, `git/gitStore.ts:342`
(`openGitSettings`). Substrate itself has the same in `Dialog.tsx:51-58`,
`Notifications`, `outputBuffer`.

### Proposed API (Substrate `ui/src/infra/state/store.ts`)

```ts
export interface Store<S> {
  get(): S;
  set(patch: Partial<S> | ((s: S) => S)): void;
  subscribe(listener: () => void): () => void;
  /** Hook; `select` + `equal` avoid re-renders for unrelated changes. */
  use<R = S>(select?: (s: S) => R, equal?: (a: R, b: R) => boolean): R;
}
export function createStore<S>(initial: S): Store<S>;

/** A fire-and-forget channel (the "bus" files). */
export interface Signal<P> { emit(payload: P): void; on(listener: (payload: P) => void): () => void; useOn(listener: (payload: P) => void): void; }
export function createSignal<P = void>(): Signal<P>;
```

### After

```ts
// src/search/searchUi.ts: 30 lines of plumbing → 3
const ui = createStore<SearchUiState>({ find: null, codeSearch: null, codeSearchPopup: false });
export const useSearchUi = () => ui.use();
export const openCodeSearch = () => ui.set({ codeSearch: { seq: ++seq } });
```
`projectProperties/bus.ts` (21 lines) and `openGitSettings`/`onOpenGitSettings` are
deleted outright by #9.

**Saved: ~130 lines.**

---

## 7. PropertyGrid descriptor builders re-invented per editor

### Today

- `editors/ContentEditor.tsx:840-910` defines `num`, `text`, `choice`, `flag`, `vec`,
  `prune` — five 10-line builders, each repeating `id, name, category, readOnly: ro`.
  Usage then repeats a lens by hand for every row:
  `num("hardness", t("Hardness"), c, b.hardness, (v) => setB((x) => void (x.hardness = v)), { min: -1 })`
  (`:946-976`, ~30 rows for block, similar for item).
- `panels/Properties.tsx:354-361` has its own `text()` builder; every read-only row is
  spelled out as a 7-line object literal (`:190-222`, `:261-348`).
- `designer/properties.ts:12-115` has the best version — a declarative `AttrSpec[]`
  table — but its `AttrKind → PropertyDescriptor` conversion is private.

### Proposed API (Substrate `ui/src/widgets/PropertyGrid/props.ts`)

```ts
/** A getter/setter pair into a draft — set(undefined) removes the key; empty parents are pruned. */
export interface Lens<D, T> { get(doc: D): T | undefined; set(draft: D, value: T | undefined): void }
export function lens<D>(path: string): Lens<D, unknown>;          // "block.hardness"

export interface PropContext<D> { doc: D; update(edit: (draft: D) => void): void; readOnly?: boolean; category: string }

export const prop: {
  text<D>(id: string, name: string, at: Lens<D, string> | string, o?: Partial<PropertyDescriptor>): (ctx: PropContext<D>) => PropertyDescriptor;
  number<D>(id: string, name: string, at: Lens<D, number> | string, o?: { min?: number; max?: number; int?: boolean } & Partial<PropertyDescriptor>): …;
  choice<D>(id: string, name: string, at: …, options: readonly string[], o?: …): …;
  flag<D>(id: string, name: string, at: …, defaultValue: boolean, o?: …): …;
  vector<D>(id: string, name: string, at: …, n: number, o?: { min?: number; max?: number; optional?: boolean }): …;
  readonly(id: string, name: string, value: PropertyValue | null, o?: Partial<PropertyDescriptor>): PropertyDescriptor;
};

export function buildProps<D>(ctx: Omit<PropContext<D>, "category">, groups: Record<string /* category, English */, Array<(ctx: PropContext<D>) => PropertyDescriptor>>): PropertyDescriptor[];
```

### After

```ts
const props = buildProps({ doc: file, update, readOnly }, {
  General: [prop.text("id", "Id", "id", { description: "The registry id — …" }), prop.text("name", "Name", "name", { suggestions: choices.strings }), …],
  Block: [
    prop.number("hardness", "Hardness", "block.hardness", { min: -1, description: "Mining time factor (stone 1.5, -1 unbreakable)." }),
    prop.number("resistance", "Blast Resistance", "block.resistance", { min: 0 }),
    prop.choice("sound", "Sound", "block.sound", SOUNDS),
    prop.number("light", "Light Level", "block.light", { min: 0, max: 15, int: true }),
    prop.flag("collision", "Collision", "block.collision", true),
    …
  ],
});
```
Names/categories/descriptions are English and translated by `PropertyGrid` (it already
calls `useT`), which removes ~100 `t(...)` wrappers from descriptor code.

**Saved: ~150 lines** (ContentEditor ~90, Properties ~40, designer ~20).

### Decision (decided 2026-10-13: as recommended)

- **D7** — Have `PropertyGrid` translate `name`/`category`/`description` itself
  (with a `raw: true` escape for mod-provided component property names, as
  `AttrSpec.raw` already does)? Recommendation: yes; it matches how `Msg` works in forms.

---

## 8. Rust command shells (src-tauri)

### Today

45 copies in `lib.rs` (21 in `git.rs`) of:
```rust
let root = PathBuf::from(project_root);
validate_within_roots(&state, &root)?;
```
17 copies in `lib.rs` of
```rust
tauri::async_runtime::spawn_blocking(move || …).await.map_err(|e| e.to_string())?
```
while `git.rs:192-198` already has a private `blocking()` helper. The `invoke_handler`
list (`lib.rs:1500-1605`) is a second hand-maintained list of every command.

### Proposal

```rust
/// A path argument already checked to be inside an open project root.
pub struct Scoped(pub PathBuf);

impl<'de, R: tauri::Runtime> tauri::ipc::CommandArg<'de, R> for Scoped {
    fn from_command(item: tauri::ipc::CommandItem<'de, R>) -> Result<Self, tauri::ipc::InvokeError> {
        let state = item.message.webview().state::<AppState>();
        let raw = String::deserialize(item)?;            // the named argument
        let path = PathBuf::from(raw);
        validate_within_roots(&state, &path).map_err(tauri::ipc::InvokeError::from)?;
        Ok(Scoped(path))
    }
}

pub async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String>;
```
```rust
#[tauri::command]
fn project_run_target_remove(project_root: Scoped, id: String) -> Result<ProjectProps, String> {
    project_properties::remove_run_target(&project_root.0, &id)
}
```
(`specta` needs `impl specta::Type for Scoped` as `String` — 3 lines.)

With D5 the eight `project_*` commands become one. With D4 the handler list is generated
from `collect_commands!` (one list instead of two).

**Saved: ~180 Rust lines** (≈2 per command × 66 + blocking 17×3 + project commands ~80, minus ~40 new).

### Decision (decided 2026-10-13: as recommended)

- **D8** — Where does `Scoped`/the project-roots sandbox live? `substrate-platform`
  has no Tauri dependency today. Options: (a) keep in Yog-IDLE (simplest);
  (b) add an optional `tauri` feature to `substrate-platform` with `ProjectRoots` state +
  `Scoped` — it is generic IDE infrastructure. Recommendation: (a) now, (b) once a second
  Substrate-based app exists.

---

## 9. Window opening plumbing

### Today

`App.tsx:585-650` owns five `useState`s for windows (`settingsOpen`, `settingsSection`,
`publishOpen`, `installerOpen`, `propertiesPage`), two subscription effects for buses
(`onOpenGitSettings`, `onOpenProjectProperties`), and drills `onOpenSettings`,
`onOpenInstaller`, `onOpenPublish` through `Shell → ShellChrome → Menu → BuildMenu →
ModBuildMenu` and into `ProjectPropertiesWindow → PublishPage` (33 occurrences of these
props). `EnvironmentSettingsPage` takes `onOpenInstaller` only to put a button on it.

### Proposed API (Substrate, built on `createStore`, like `DialogHost`)

```ts
export interface WindowDef<P = void> { id: string; render: (props: P, close: () => void) => ReactNode; /** One instance; reopening re-focuses/re-keys. */ single?: boolean }
export function defineWindow<P = void>(def: WindowDef<P>): { open(props: P): void; close(): void; useIsOpen(): boolean };
export function WindowHost(): JSX.Element;   // mounted by PlatformShell next to DialogHost
```

```ts
// src/windows.ts (Yog-IDLE)
export const optionsWindow   = defineWindow<{ section?: string }>({ id: "options", single: true, render: (p, close) => <SettingsWindow sections={useSettingsSections()} initialSectionId={p.section} onClose={close} /> });
export const publishWindow   = defineWindow<{ root: string }>({ id: "publish", single: true, render: (p, close) => <PublishWindow projectRoot={p.root} onClose={close} /> });
export const installerWindow = defineWindow({ id: "installer", single: true, render: (_, close) => <EnvironmentWindow onClose={close} /> });
export const projectPropertiesWindow = defineWindow<{ root: string; name: string; page?: ProjectPropertiesPage }>({ … });
```
Anything calls `publishWindow.open({ root })` — or, with #4, `runCommand("build.publish")`.

**Saved: ~120 lines** (`bus.ts`, the gitStore settings channel, App's state/effects and
all drilled props).

---

## 10. Error messages and reporting

### Today — five spellings

- `String(err)` (52×), `err instanceof Error ? err.message : String(err)` (Form.tsx,
  PropertyGrid.tsx, `api.ts:57`, `ScreenDesigner.tsx:1026`).
- Backend message translated: `errorText(err)` (`projectProperties/api.ts:56-59`),
  `t(String(err))` (`GitSettings.tsx:16`, `GitRepositoryWindow.tsx:55`,
  `DiffDocument.tsx:35`) — but not in `Properties.tsx:138,143` or `PublishWindow.tsx:45`.
- 23× `reportError(t("X failed: {error}", { …, error: String(err) }))`, and
  `PublishWindow.tsx:44-48` / `ProjectExplorer.tsx:66-69` build `` `${what}: ${err}` ``
  untranslated.

### Proposed API (Substrate)

```ts
/** A display string for anything thrown/rejected — Error.message, a string (a Tauri command's Err), or JSON; backend English is passed through `t`. */
export function errorMessage(err: unknown): string;

/** Output's General source + an error notification. `what` is the English context ("Failed to save {path}"). */
export function reportError(what: Msg, err?: unknown): void;

/** `promise.catch(err => reportError(what, err))`, returning undefined on failure. */
export function attempt<T>(promise: Promise<T>, what: Msg): Promise<T | undefined>;
```
Yog-IDLE's `reportError.tsx` is deleted (the Output event name becomes a Substrate
setting of `OutputPanel`'s "ide" source). The locale entries collapse too: today every
`"… failed: {error}"` string is a separate key; with `reportError(what, err)` the
`": {error}"` suffix is added once.

**Saved: ~60 lines; one rule for "is a backend message translated" (always).**

### Decision (decided 2026-10-13: as recommended)

- **D9** — Backend errors are English strings that the UI translates by exact match
  (`t(String(err))`). Keep that, or have Rust return `{ code, params }` and translate
  from codes? Recommendation: keep exact-match for now (it works, ~1,385 keys in `ru.ts` already), but
  route it through `errorMessage` only.

---

## 11. Tauri event subscriptions

### Today

`useGameStatus.tsx:59-139`, `outputSource.tsx:72-89`, `App.tsx:221-228`,
`useModRunTargets.tsx:28-35`, `environmentStore.ts:252-275`, `useDebugSession.tsx:79-126`
(five separately named `unlistenX` promises and five `.then(f => f())`),
`useHotReload.tsx:17-19`. Event names are bare strings and payload types are re-declared
per listener.

### Proposed API (Substrate)

```ts
/** Subscribes for the component's lifetime; handlers read live (no deps). */
export function useEvents(handlers: Record<string, (payload: any) => void>): void;
/** Typed variant over tauri-specta's generated `events` (D4). */
export function useEvent<T>(event: { listen(cb: (e: { payload: T }) => void): Promise<() => void> }, handler: (payload: T) => void): void;
```
```ts
useEvents({
  "workflow-start": () => setActive((n) => n + 1),
  "workflow-exit": (p: WorkflowExitEvent | null) => p && setActive((n) => Math.max(0, n - 1)),
});
```

**Saved: ~60 lines.**

---

## 12. i18n side-plumbing

The i18n core is fine: English keys, `t`/`pt`/`tn`, 938 distinct `t("…")` literals with
only 5 missing from `ru.ts`. The boilerplate is around it:

- Hand-kept keyword arrays for Options search: `gitSettingsKeywords`
  (`GitSettings.tsx:77`), `environmentSettingsKeywords` (`EnvironmentSettings.tsx:51-61`),
  Substrate's `editorSettingsKeywords`, `appearanceSettingsKeywords`,
  `internationalSettingsKeywords`. → `schemaKeywords(schema)` (#1); deleted. Terms that are
  not labels (`user.name`, "Java", "CARGO_HOME") move to the schema's `keywords` (capability rule:
  nothing findable today stops being findable).
- "English; shown through `t`" tables translated at render time (`MODES` in
  `PublishWindow.tsx:14-18`, `EMPTY_LABELS` in `App.tsx:136-143`, `changeKindLabel` in
  `gitApi.ts:136-155`, `LANGUAGES` in `Properties.tsx:42-62`). With `Msg` as the
  convention (English everywhere in data, `t` at the edge) these stay but stop needing
  per-site comments; menu/toolbar labels move into command defs (#4).
- `useLocale()` called only to re-render (11 sites) plus `useMemo(…, [locale])` with an
  eslint-disable (`App.tsx:572-573, 592-593`, `ProjectPropertiesWindow.tsx:88-89`). Once
  labels are English in data and translated in the widgets, these go.
- Add a tiny check script (`scripts/i18n-check.mjs`, plain Node, no build) listing
  `t("…")`/`Msg` literals missing from `ru.ts` and unused keys. Not a line saver, but it
  replaces manual "did I add the Russian string" bookkeeping.

**Saved: ~40 lines.**

---

## What is already good (leave alone)

- `designer/properties.ts`' `AttrSpec[]` table and `NewItemDialog`'s `ITEM_TEMPLATES` —
  already declarative; they only gain from #7.
- The backend "write returns the re-read state" contract (`project_properties::edit`)
  — it's what makes `useRemoteSource` trivial.
- `CommitTextField`/`StringListField` semantics; the schema renderer is a thin layer over
  them.
- `useStoredState`, `StateStore`, `keys.tsx` (chords, layout independence, overrides).

---

## Staged plan

Each stage is one commit per repo, migrates every call site, and deletes the old code.
Substrate commits land first; Yog-IDLE follows against the local path dependency.

**Stage 1 — primitives (Substrate), no UI change.**
`createStore`/`createSignal`, `useResource`/`useAction`, `errorMessage`/`reportError`/
`attempt`, `useEvents`. Migrate Substrate's own copies (Dialog queue, Notifications,
outputBuffer). Yog-IDLE: migrate the 14 stores/buses (#6), ~20 load sites (#5), error
reporting (#10), event subscriptions (#11); delete `reportError.tsx`,
`requestOpenFile` alias.
*≈ −450 lines.*

**Stage 2 — typed backend (Yog-IDLE, Rust + TS).** (needs D4, D5, D8)
`specta` derives, `tauri-specta` builder, generated `src/bindings.ts`; `Scoped`
extractor and shared `blocking()`; `project_edit` replaces the eight project commands;
delete `mod_manifest_*`. Replace every `invoke` with `commands.*`; delete `gitApi`
wrappers, `projectProperties/api.ts` types, duplicated interfaces.
*≈ −600 lines (TS + Rust).*

**Stage 3 — schema forms (Substrate `Form/schema.ts`, `RecordList`) + Yog schemas.** (needs D1, D2)
Substrate pages (Editor/Appearance/International settings) first, then Git settings,
Environment, the five Project Properties pages, PublishWindow (buffered). Delete the
`*Keywords` arrays.
*≈ −700 lines.*

**Stage 4 — properties.** (needs D3, D7)
`prop.*` builders + `buildProps` + `schemaToProperties`; migrate ContentEditor,
Properties tool window (onto `applicationForm`), designer.
*≈ −270 lines.*

**Stage 5 — commands and windows.** (needs D6)
Command registry + unified `MenuEntry`; migrate menus, toolbar, DebugPanel, context
menus (Project Explorer, Git Changes, Output), ContentEditor/ScreenDesigner keybindings;
`defineWindow`/`WindowHost`; delete drilled `onOpen*` props, `projectProperties/bus.ts`,
`openGitSettings` channel.
*≈ −370 lines.*

Order rationale: 1 and 2 shrink every later diff (forms and commands are written against
`useResource` and `commands.*` from the start); 3 is the user-visible "simple forms"
win; 5 touches the most files and is easiest once everything else is smaller.

Verification per stage (when building is allowed): `tsc` for both packages, the
existing `cargo test` in `src-tauri` (project_properties/environment have tests), then a
manual pass over Options, Project Properties, Properties window, Publish, menus and
shortcuts (including a user keymap override showing up in menus after stage 5).

---

## Decisions for the user (collected)

| ID | Question | Recommendation |
|---|---|---|
| D1 | Keep TS validators that duplicate Rust `check_field`, or rely on backend rejection on commit? | Backend-only for `yog.toml` fields |
| D2 | Immediate commit everywhere vs Apply/OK for Options | Immediate for pages, buffered for dialogs |
| D3 | Properties tool window: editable `[mod]` rows or read-only + "…" to Project Properties | Either; read-only is closer to VS |
| D4 | Add `tauri-specta`/`specta` and commit generated `bindings.ts` | Yes |
| D5 | Collapse 8 `project_*` commands into `project_edit(ProjectEdit)` | Yes |
| D6 | One `MenuEntry` type for menu bar / context menu / toolbar / tree menus (breaking) | Yes |
| D7 | `PropertyGrid` translates names/categories/descriptions itself | Yes |
| D8 | `Scoped` path extractor in Yog-IDLE or a `tauri` feature of `substrate-platform` | Yog-IDLE for now |
| D9 | Backend errors: keep exact-string translation or move to error codes | Keep, centralize |
