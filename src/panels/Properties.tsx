import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PropertyGrid, useSelection, type PropertyDescriptor, type ShellSelection } from "substrate-platform-ui";
import { useActiveFileTab, useOpenFiles } from "../OpenFilesContext";
import { useProject } from "../ProjectContext";
import { renamePath, selectPath, type IdeSelectionData } from "../ideSelection";
import { baseName, extensionOf, samePath, validateEntryName } from "../paths";

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
  section: string;
  fields: Partial<Record<ManifestField, string>>;
  authors: string[];
  dependencies: number;
  modDependencies: number;
  runConfigs: number;
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

const LANGUAGES: Record<string, string> = {
  rs: "Rust",
  toml: "TOML",
  json: "JSON",
  md: "Markdown",
  java: "Java",
  xml: "XML",
  svg: "SVG",
  properties: "Java Properties",
  lang: "Minecraft Language",
  png: "PNG Image",
  jpg: "JPEG Image",
  jpeg: "JPEG Image",
  gif: "GIF Image",
  txt: "Plain Text",
  sh: "Shell Script",
  gradle: "Gradle",
  kts: "Kotlin Script",
  yml: "YAML",
  yaml: "YAML",
};

function languageOf(path: string): string {
  const ext = extensionOf(path);
  return LANGUAGES[ext] ?? (ext ? ext.toUpperCase() : "Plain Text");
}

function formatSize(bytes: number): string {
  const exact = `${bytes.toLocaleString()} bytes`;
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
  if (crlf && lf) return "Mixed (CRLF and LF)";
  if (crlf) return "CRLF (Windows)";
  if (lf) return "LF (Unix)";
  return "None (single line)";
}

/** Rejects a name `validateEntryName` won't take — its `""` (blank) still gets a message here, since this has no OK button to grey out. */
function validateName(value: unknown): string | null {
  const problem = validateEntryName(String(value));
  return problem === "" ? "A name can't be empty." : problem;
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
  const selection = useSelection<IdeSelectionData>();
  const { tabs, pathRenamed, recheckDisk } = useOpenFiles();
  const { project } = useProject();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reloads, setReloads] = useState(0);
  const path = selection && selection.kind !== "multiple" ? selection.data.path : null;
  const tab = path ? tabs.find((t) => t.path === path) : undefined;
  // Saving the file changes its size and timestamp — re-read then too.
  const savedText = tab?.diskContent;

  useEffect(() => {
    if (!selection || !path) {
      setLoaded(null);
      return;
    }
    let cancelled = false;
    (async () => {
      let next: Loaded;
      try {
        const info = await invoke<PathInfo>("path_info", { path });
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
  }, [selection, path, reloads, savedText]);

  if (!selection) return <PropertyGrid properties={[]} emptyLabel="Select a file or folder in Project Explorer, or click into an editor." />;
  if (selection.kind === "multiple") return <PropertyGrid properties={[]} emptyLabel="Multiple items are selected." />;
  if (!loaded || !path) return <PropertyGrid properties={[]} emptyLabel="Loading…" />;

  const shownPath = loaded.selection.data.path;
  const name = baseName(shownPath);
  if (!loaded.info) return <PropertyGrid properties={[]} emptyLabel={`Couldn't read ${name}: ${loaded.error}`} />;

  const info = loaded.info;
  const isRoot = project?.root === shownPath;
  const reload = () => setReloads((n) => n + 1);

  const rename = async (value: unknown) => {
    await renamePath(shownPath, String(value).trim(), pathRenamed);
  };

  const properties: PropertyDescriptor[] = [];
  let objectType: string;

  if (info.kind === "file") {
    objectType = "File Properties";
    properties.push(...fileProperties(shownPath, info, rename, reload));
    // An open tab knows more about its text than the disk listing does.
    const openTab = tabs.find((t) => t.path === shownPath);
    if (openTab?.textLoaded) {
      const text = openTab.content;
      properties.push(
        {
          id: "encoding",
          name: "Encoding",
          category: "Editor",
          value: text.startsWith("﻿") ? "UTF-8 with BOM" : "UTF-8",
          readOnly: true,
          description: "How the file's text is stored on disk. Yog IDLE reads and writes files as UTF-8.",
        },
        {
          id: "lineEndings",
          name: "Line Endings",
          category: "Editor",
          value: lineEndingsOf(text),
          readOnly: true,
          description: "The line break sequence the open text uses.",
        },
        { id: "lines", name: "Lines", category: "Editor", value: text.split("\n").length, readOnly: true, description: "Lines in the open text." },
        {
          id: "language",
          name: "Language",
          category: "Editor",
          value: languageOf(shownPath),
          readOnly: true,
          description: "The language the file is edited as.",
        },
        {
          id: "unsaved",
          name: "Unsaved Changes",
          category: "Editor",
          value: openTab.dirty,
          readOnly: true,
          description: "Whether the open tab has edits that aren't saved to disk yet.",
        }
      );
    }
  } else {
    objectType = info.isModProject ? "Project Properties" : "Folder Properties";
    properties.push(...folderProperties(shownPath, info, isRoot ? null : rename));
    if (info.isModProject) {
      if (loaded.manifest) {
        const update = async (key: string, value: string | string[]) => {
          // Don't write under an editor holding unsaved yog.toml edits —
          // saving that tab would silently undo this change.
          const manifestTab = tabs.find((t) => samePath(t.path, `${shownPath}/yog.toml`) && t.dirty);
          if (manifestTab) return "yog.toml has unsaved changes in the editor — save or discard them first.";
          const manifest = await invoke<Manifest>("mod_manifest_set", { projectRoot: shownPath, key, value });
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
          category: "Mod",
          value: loaded.error,
          readOnly: true,
          description: "yog.toml couldn't be read.",
        });
      }
    }
  }

  return <PropertyGrid objectName={name} objectType={objectType} objectKey={shownPath} properties={properties} persistKey="properties" />;
}

function fileProperties(path: string, info: PathInfo, rename: (value: unknown) => Promise<void>, reload: () => void): PropertyDescriptor[] {
  const ext = extensionOf(path);
  return [
    {
      id: "name",
      name: "File Name",
      category: "Misc",
      value: baseName(path),
      validate: validateName,
      onCommit: rename,
      description: "The file's name. Renaming it here renames it on disk; open tabs follow it.",
    },
    { id: "fullPath", name: "Full Path", category: "Misc", value: path, readOnly: true, description: "Where the file is on disk." },
    {
      id: "type",
      name: "Type",
      category: "Misc",
      value: ext ? `${languageOf(path)} (.${ext})` : "File",
      readOnly: true,
      description: "The kind of file, by its extension.",
    },
    {
      id: "size",
      name: "Size",
      category: "Details",
      value: info.size,
      displayValue: formatSize(info.size),
      readOnly: true,
      description: "The file's size on disk.",
    },
    {
      id: "modified",
      name: "Date Modified",
      category: "Details",
      value: formatDate(info.modified),
      readOnly: true,
      description: "When the file was last written.",
    },
    {
      id: "created",
      name: "Date Created",
      category: "Details",
      value: formatDate(info.created),
      readOnly: true,
      description: "When the file was created, where the file system records it.",
    },
    {
      id: "readOnly",
      name: "Read Only",
      category: "Details",
      value: info.readOnly,
      description: "Whether the file is write-protected on disk (the owner's write permission).",
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
      name: "Folder Name",
      category: "Misc",
      value: baseName(path),
      validate: validateName,
      onCommit: rename ?? undefined,
      description: rename
        ? "The folder's name. Renaming it here renames it on disk; open tabs inside it follow."
        : "The open project's folder — reopen it from its new place to rename it.",
    },
    { id: "fullPath", name: "Full Path", category: "Misc", value: path, readOnly: true, description: "Where the folder is on disk." },
    {
      id: "items",
      name: "Items",
      category: "Details",
      value: info.itemCount,
      readOnly: true,
      description: "Files and folders directly inside this folder (not counting their contents).",
    },
    {
      id: "modified",
      name: "Date Modified",
      category: "Details",
      value: formatDate(info.modified),
      readOnly: true,
      description: "When the folder's contents last changed.",
    },
  ];
}

/** The `[mod]` fields of `yog.toml`, editable — `update` writes one back (resolving an error message if it couldn't). */
function manifestProperties(manifest: Manifest, update: (key: string, value: string | string[]) => Promise<string | null>): PropertyDescriptor[] {
  const field = (key: ManifestField) => manifest.fields[key] ?? "";
  const text = (key: ManifestField, name: string, description: string): PropertyDescriptor => ({
    id: `mod.${key}`,
    name,
    category: "Mod",
    value: field(key),
    description,
    onCommit: (value) => update(key, String(value)),
  });
  return [
    text("id", "Id", "The mod's unique id (lowercase letters, digits, '-' and '_'). Other mods and saved worlds refer to the mod by it — change with care."),
    text("name", "Name", "The mod's display name."),
    text("version", "Version", "The mod's version, as semver (1.2.3)."),
    text("description", "Description", "A one-line summary of what the mod does."),
    {
      id: "mod.authors",
      name: "Authors",
      category: "Mod",
      value: manifest.authors.join(", "),
      description: "Who made the mod, separated by commas.",
      onCommit: (value) =>
        update(
          "authors",
          String(value)
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean)
        ),
    },
    text("license", "License", "The mod's license, as an SPDX expression. Empty uses yog's default (MIT OR Apache-2.0)."),
    text(
      "exports_license",
      "Exports License",
      "License of the generated exports crate other mods depend on (`yog publish exports`). Empty uses MIT OR Apache-2.0, whatever the mod's own license."
    ),
    {
      id: "mod.edition",
      name: "Rust Edition",
      category: "Mod",
      kind: "enum",
      options: ["2015", "2018", "2021", "2024"],
      value: field("edition"),
      description: "The Rust edition the mod's code is compiled with. Empty uses yog's default (2021).",
      onCommit: (value) => update("edition", String(value)),
    },
    {
      id: "deps.crates",
      name: "Crate Dependencies",
      category: "Dependencies",
      value: manifest.dependencies,
      readOnly: true,
      description: "crates.io crates listed under [dependencies] — edit yog.toml to change them.",
    },
    {
      id: "deps.mods",
      name: "Mod Dependencies",
      category: "Dependencies",
      value: manifest.modDependencies,
      readOnly: true,
      description: "Other Yog mods this mod uses, from [dependencies.exports].",
    },
    {
      id: "deps.runs",
      name: "Run Configurations",
      category: "Dependencies",
      value: manifest.runConfigs,
      readOnly: true,
      description: "[run.<name>] launch configurations — the targets in the Run toolbar.",
    },
    {
      id: "deps.apiPath",
      name: "yog-api Path",
      category: "Dependencies",
      value: manifest.yogApiPath ?? "",
      readOnly: true,
      description: "[dev] yog_api_path: builds against a local yog-api checkout instead of crates.io. Empty when unset.",
    },
  ];
}

/** Activating an editor tab makes its file the selection, as clicking into it does — Visual Studio's Properties follows the active document. Render once inside the shell. */
export function ActiveDocumentSelection() {
  const path = useActiveFileTab()?.path;
  useEffect(() => {
    if (path) selectPath(path, "file", "editor");
  }, [path]);
  return null;
}
