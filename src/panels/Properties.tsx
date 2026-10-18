import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  activatePropertyContext,
  fileTypeOf,
  getCurrentSelection,
  PROPERTIES_KIND,
  PropertyGrid,
  t,
  tn,
  useHasPropertyContext,
  useLocale,
  useSelection,
  type PropertyDescriptor,
  type PropertySet,
  type ShellSelection,
  fileNameOf,
  extensionOf,
  joinPath,
  pushDocumentStep,
  UndoScope,
} from "substrate-platform-ui";
import { useActiveFileTab, useOpenFiles } from "../OpenFilesContext";
import { useProject } from "../ProjectContext";
import { renamePath, selectDocument, type IdeSelectionData } from "../ideSelection";
import { samePath, validateEntryName } from "../paths";
import { files } from "../files";
import { editManifest } from "../projectProperties/manifestHistory";
import { reportError } from "../reportError";
import "./Properties.css";

/** The history of what Properties changes outside any document: renames, yog.toml fields. */
const PROPERTIES_HISTORY = "properties";

/** `path_info`'s answer (see `properties.rs`). */
interface PathInfo {
  kind: "file" | "dir";
  size: number;
  modified: number | null;
  created: number | null;
  readOnly: boolean;
  itemCount: number | null;
  isModProject: boolean;
}

/** `mod_manifest_read`/`mod_manifest_set`'s answer — a mod's `yog.toml`, summarized. */
interface Manifest {
  fields: Partial<Record<ManifestField, string>>;
  authors: string[];
  dependencies: number;
  modDependencies: number;
  yogApiPath: string | null;
}

type ManifestField = "id" | "name" | "version" | "description" | "license" | "exports_license" | "edition";

/** What's been read for the shown selection — kept while the next one loads, so the grid doesn't flash empty. */
interface Loaded {
  selection: ShellSelection<IdeSelectionData>;
  info: PathInfo | null;
  manifest: Manifest | null;
  /** Why `info`/`manifest` couldn't be read. */
  error: string | null;
}

/** What kind of file `path` is, as the file types name it (Rust, PNG Image, Yog Screen) — else its extension. */
function kindOf(path: string): string {
  const ext = extensionOf(path);
  return fileTypeOf(path)?.name ? t(fileTypeOf(path)!.name) : ext ? ext.toUpperCase() : t("File");
}

function formatSize(bytes: number): string {
  const exact = tn(bytes, "{count} byte", "{count} bytes", { count: bytes.toLocaleString() });
  if (bytes < 1024) return exact;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]} (${exact})`;
}

function formatDate(ms: number | null): string {
  return ms === null ? "" : new Date(ms).toLocaleString();
}

function lineEndingsOf(text: string): string {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  if (crlf && lf) return t("Mixed (CRLF and LF)");
  if (crlf) return t("CRLF (Windows)");
  if (lf) return t("LF (Unix)");
  return t("None (single line)");
}

/** Rejects a name `validateEntryName` won't take — its `""` (blank) still gets a message here, since this has no OK button to grey out. */
function validateName(value: unknown): string | null {
  const problem = validateEntryName(String(value));
  return problem === "" ? t("A name can't be empty.") : problem;
}

/**
 * The Properties tool window, Visual Studio style — follows the global
 * selection (`ideSelection`: a Project Explorer item, or the editor last
 * focused) and shows a file's, folder's or mod project's properties in
 * substrate-platform-ui's `PropertyGrid`. Name edits rename through
 * Project Explorer (open tabs follow); a mod project's `yog.toml` fields
 * are written back in place by the backend, formatting kept.
 */
export function Properties() {
  useLocale();
  const selection = useSelection<IdeSelectionData>();
  const { tabs, pathRenamed, recheckDisk } = useOpenFiles();
  const { project } = useProject();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reloads, setReloads] = useState(0);
  const isContext = selection?.kind === PROPERTIES_KIND;
  // Only a file or folder is read here: a window's context republishes on
  // every change of its own and must not restart (or reset) that.
  const fileSelection = selection && selection.kind !== "multiple" && !isContext ? selection : null;
  const path = fileSelection ? fileSelection.data.path : null;
  const tab = path ? tabs.find((t) => t.path === path) : undefined;
  // Saving the file changes its size and timestamp — re-read then too.
  const savedText = tab?.diskContent;

  useEffect(() => {
    const selection = fileSelection;
    if (!selection || !path) {
      setLoaded(null);
      return;
    }
    let cancelled = false;
    (async () => {
      let next: Loaded;
      try {
        const info = await files.info(path);
        let manifest: Manifest | null = null;
        let error: string | null = null;
        if (info.isModProject) {
          try {
            manifest = await invoke<Manifest>("mod_manifest_read", { projectRoot: path });
          } catch (err) {
            error = String(err);
          }
        }
        next = { selection, info, manifest, error };
      } catch (err) {
        next = { selection, info: null, manifest: null, error: String(err) };
      }
      if (!cancelled) setLoaded(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [fileSelection, path, reloads, savedText]);

  if (!selection) return <PropertyGrid properties={[]} emptyLabel={t("Select a file or folder in Project Explorer, or click into an editor.")} />;
  if (isContext) {
    // An active window's own context (a designer's selected element) — it builds the rows.
    const { header, footer, ...grid } = selection.data as unknown as PropertySet;
    // Ctrl+Z here undoes in the document the rows edit.
    return (
      <div className="properties-context" data-undo-scope={selection.source}>
        {header && <div className="properties-context-header">{header}</div>}
        <div className="properties-context-grid">
          <PropertyGrid {...grid} persistKey="properties" />
        </div>
        {footer && <div className="properties-context-footer">{footer}</div>}
      </div>
    );
  }
  if (selection.kind === "multiple") return <PropertyGrid properties={[]} emptyLabel={t("Multiple items are selected.")} />;
  if (!loaded || !path) return <PropertyGrid properties={[]} emptyLabel={t("Loading…")} />;

  const shownPath = loaded.selection.data.path;
  const name = fileNameOf(shownPath);
  if (!loaded.info) return <PropertyGrid properties={[]} emptyLabel={t("Couldn't read {name}: {error}", { name, error: loaded.error ?? "" })} />;

  const info = loaded.info;
  const isRoot = project?.root === shownPath;
  const reload = () => setReloads((n) => n + 1);

  const rename = async (value: unknown) => {
    const to = String(value).trim();
    const from = fileNameOf(shownPath);
    await renamePath(shownPath, to, pathRenamed);
    const renamed = joinPath(shownPath.replace(/[/\\][^/\\]*$/, ""), to);
    pushDocumentStep(PROPERTIES_HISTORY, {
      undo: () => void renamePath(renamed, from, pathRenamed).catch((e) => reportError(String(e))),
      redo: () => void renamePath(shownPath, to, pathRenamed).catch((e) => reportError(String(e))),
    });
  };

  const properties: PropertyDescriptor[] = [];
  let objectType: string;

  if (info.kind === "file") {
    objectType = t("File Properties");
    properties.push(...fileProperties(shownPath, info, rename, reload));
    // An open tab knows more about its text than the disk listing does.
    const openTab = tabs.find((t) => t.path === shownPath);
    if (openTab?.textLoaded) {
      const text = openTab.content;
      properties.push(
        {
          id: "encoding",
          name: t("Encoding"),
          category: t("Editor"),
          value: text.startsWith("﻿") ? t("UTF-8 with BOM") : "UTF-8",
          readOnly: true,
          description: t("How the file's text is stored on disk. Yog IDLE reads and writes files as UTF-8."),
        },
        {
          id: "lineEndings",
          name: t("Line Endings"),
          category: t("Editor"),
          value: lineEndingsOf(text),
          readOnly: true,
          description: t("The line break sequence the open text uses."),
        },
        { id: "lines", name: t("Lines"), category: t("Editor"), value: text.split("\n").length, readOnly: true, description: t("Lines in the open text.") },
        {
          id: "language",
          name: t("Language"),
          category: t("Editor"),
          value: kindOf(shownPath),
          readOnly: true,
          description: t("The language the file is edited as."),
        },
        {
          id: "unsaved",
          name: t("Unsaved Changes"),
          category: t("Editor"),
          value: openTab.dirty,
          readOnly: true,
          description: t("Whether the open tab has edits that aren't saved to disk yet."),
        }
      );
    }
  } else {
    objectType = info.isModProject ? t("Project Properties") : t("Folder Properties");
    properties.push(...folderProperties(shownPath, info, isRoot ? null : rename));
    if (info.isModProject) {
      if (loaded.manifest) {
        const update = async (key: string, value: string | string[]) => {
          // Don't write under an editor holding unsaved yog.toml edits —
          // saving that tab would silently undo this change.
          const manifestTab = tabs.find((t) => samePath(t.path, `${shownPath}/yog.toml`) && t.dirty);
          if (manifestTab) return t("yog.toml has unsaved changes in the editor — save or discard them first.");
          const manifest = await editManifest(PROPERTIES_HISTORY, shownPath, () => invoke<Manifest>("mod_manifest_set", { projectRoot: shownPath, key, value }), () => {
            reload();
            void recheckDisk();
          });
          setLoaded((prev) => (prev && prev.selection === loaded.selection ? { ...prev, manifest } : prev));
          // A clean yog.toml tab shows the new text.
          await recheckDisk();
          return null;
        };
        properties.push(...manifestProperties(loaded.manifest, update));
      } else if (loaded.error) {
        properties.push({
          id: "manifestError",
          name: "yog.toml",
          category: t("Mod"),
          value: loaded.error,
          readOnly: true,
          description: t("yog.toml couldn't be read."),
        });
      }
    }
  }

  return (
    <UndoScope id={PROPERTIES_HISTORY}>
      <PropertyGrid objectName={name} objectType={objectType} objectKey={shownPath} properties={properties} persistKey="properties" />
    </UndoScope>
  );
}

function fileProperties(path: string, info: PathInfo, rename: (value: unknown) => Promise<void>, reload: () => void): PropertyDescriptor[] {
  const ext = extensionOf(path);
  return [
    {
      id: "name",
      name: t("File Name"),
      category: t("Misc"),
      value: fileNameOf(path),
      validate: validateName,
      onCommit: rename,
      description: t("The file's name. Renaming it here renames it on disk; open tabs follow it."),
    },
    { id: "fullPath", name: t("Full Path"), category: t("Misc"), value: path, readOnly: true, description: t("Where the file is on disk.") },
    {
      id: "type",
      name: t("Type"),
      category: t("Misc"),
      value: ext ? `${kindOf(path)} (.${ext})` : t("File"),
      readOnly: true,
      description: t("The kind of file, by its extension."),
    },
    {
      id: "size",
      name: t("Size"),
      category: t("Details"),
      value: info.size,
      displayValue: formatSize(info.size),
      readOnly: true,
      description: t("The file's size on disk."),
    },
    {
      id: "modified",
      name: t("Date Modified"),
      category: t("Details"),
      value: formatDate(info.modified),
      readOnly: true,
      description: t("When the file was last written."),
    },
    {
      id: "created",
      name: t("Date Created"),
      category: t("Details"),
      value: formatDate(info.created),
      readOnly: true,
      description: t("When the file was created, where the file system records it."),
    },
    {
      id: "readOnly",
      name: t("Read Only"),
      category: t("Details"),
      value: info.readOnly,
      description: t("Whether the file is write-protected on disk (the owner's write permission)."),
      onCommit: async (value) => {
        await invoke("path_set_readonly", { path, readOnly: value === true });
        reload();
      },
    },
  ];
}

function folderProperties(path: string, info: PathInfo, rename: ((value: unknown) => Promise<void>) | null): PropertyDescriptor[] {
  return [
    {
      id: "name",
      name: t("Folder Name"),
      category: t("Misc"),
      value: fileNameOf(path),
      validate: validateName,
      onCommit: rename ?? undefined,
      description: rename
        ? t("The folder's name. Renaming it here renames it on disk; open tabs inside it follow.")
        : t("The open project's folder — reopen it from its new place to rename it."),
    },
    { id: "fullPath", name: t("Full Path"), category: t("Misc"), value: path, readOnly: true, description: t("Where the folder is on disk.") },
    {
      id: "items",
      name: t("Items"),
      category: t("Details"),
      value: info.itemCount,
      readOnly: true,
      description: t("Files and folders directly inside this folder (not counting their contents)."),
    },
    {
      id: "modified",
      name: t("Date Modified"),
      category: t("Details"),
      value: formatDate(info.modified),
      readOnly: true,
      description: t("When the folder's contents last changed."),
    },
  ];
}

/** The `[mod]` fields of `yog.toml`, editable — `update` writes one back (resolving an error message if it couldn't). */
function manifestProperties(manifest: Manifest, update: (key: string, value: string | string[]) => Promise<string | null>): PropertyDescriptor[] {
  const field = (key: ManifestField) => manifest.fields[key] ?? "";
  const text = (key: ManifestField, name: string, description: string): PropertyDescriptor => ({
    id: `mod.${key}`,
    name,
    category: t("Mod"),
    value: field(key),
    description,
    onCommit: (value) => update(key, String(value)),
  });
  return [
    text("id", t("Id"), t("The mod's unique id (lowercase letters, digits, '-' and '_'). Other mods and saved worlds refer to the mod by it — change with care.")),
    text("name", t("Name"), t("The mod's display name.")),
    text("version", t("Version"), t("The mod's version, as semver (1.2.3).")),
    text("description", t("Description"), t("A one-line summary of what the mod does.")),
    {
      id: "mod.authors",
      name: t("Authors"),
      category: t("Mod"),
      value: manifest.authors.join(", "),
      description: t("Who made the mod, separated by commas."),
      onCommit: (value) =>
        update(
          "authors",
          String(value)
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean)
        ),
    },
    text("license", t("License"), t("The mod's license, as an SPDX expression. Empty uses yog's default (MIT OR Apache-2.0).")),
    text(
      "exports_license",
      t("Exports License"),
      t("License of the generated exports crate other mods depend on (`yog publish exports`). Empty uses MIT OR Apache-2.0, whatever the mod's own license.")
    ),
    {
      id: "mod.edition",
      name: t("Rust Edition"),
      category: t("Mod"),
      kind: "enum",
      options: ["2015", "2018", "2021", "2024"],
      value: field("edition"),
      description: t("The Rust edition the mod's code is compiled with. Empty uses yog's default (2021)."),
      onCommit: (value) => update("edition", String(value)),
    },
    {
      id: "deps.crates",
      name: t("Crate Dependencies"),
      category: t("Dependencies"),
      value: manifest.dependencies,
      readOnly: true,
      description: t("crates.io crates listed under [dependencies] — edit yog.toml to change them."),
    },
    {
      id: "deps.mods",
      name: t("Mod Dependencies"),
      category: t("Dependencies"),
      value: manifest.modDependencies,
      readOnly: true,
      description: t("Other Yog mods this mod uses, from [dependencies.exports]."),
    },
    {
      id: "deps.apiPath",
      name: t("yog-api Path"),
      category: t("Dependencies"),
      value: manifest.yogApiPath ?? "",
      readOnly: true,
      description: t("[dev] yog_api_path: builds against a local yog-api checkout instead of crates.io. Empty when unset."),
    },
  ];
}

/**
 * Activating an editor tab selects it as clicking into it does
 * (`selectDocument`) — and a designer whose context comes once it has
 * loaded takes over from its file. Render once inside the shell.
 */
export function ActiveDocumentSelection() {
  const path = useActiveFileTab()?.path;
  const hasContext = useHasPropertyContext(path);
  useEffect(() => {
    if (path) selectDocument(path);
  }, [path]);
  useEffect(() => {
    // Only while the document itself is what's shown (not Explorer's pick).
    const current = getCurrentSelection();
    if (path && hasContext && current?.id === path && current.source === "editor") activatePropertyContext(path);
  }, [path, hasContext]);
  return null;
}
