import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ContextMenu,
  FileTree,
  Icon,
  Toolbar,
  confirmDialog,
  editorProvidersFor,
  generalEditorProviders,
  matchesShortcut,
  nestFiles,
  openTerminalIn,
  promptDialog,
  useContextMenu,
  useDirectoryTree,
  useShell,
  t,
  useT,
  type ContextMenuItem,
  type FileTreeMenuItem,
  type FileTreeNode,
  fileNameOf,
} from "substrate-platform-ui";
import { useProject, type ProjectInfo } from "../ProjectContext";
import { openWithItems, useOpenFiles } from "../OpenFilesContext";
import { openFile } from "../fileOpenBus";
import { reportError } from "../reportError";
import { EVENT, emitTo } from "../events";
import { generatedCodePath, isWithin, parentOf, renamedPath, validateEntryName as validateName } from "../paths";
import { openProjectProperties } from "../projectProperties/bus";
import { registerExplorerRename, renamePath, selectionPathRemoved, selectionPathRenamed, selectMultiple, selectPath } from "../ideSelection";
import { NewItemDialog, templateFiles, type ItemTemplate } from "./NewItemDialog";
import { files, readModId } from "../files";
import { useFsChanged, useWatchedFolders } from "../fsWatch";

/** A folder that failed to list stays unloaded in the tree (expanding it again retries) — say why in Output rather than only the devtools console. */
function reportListError(error: unknown, path: string) {
  emitTo(EVENT.ideOutput, `[error] failed to list ${path}: ${error}`);
}

export function ProjectExplorer() {
  const t = useT();
  const { project, error } = useProject();

  if (!project) {
    return (
      <div style={{ padding: "var(--sp-space-sm)", color: "var(--sp-text-muted)" }}>
        {error ? t("Failed to open project: {error}", { error }) : t("No project open — use File > Open Project or Open Folder.")}
      </div>
    );
  }
  return <ProjectExplorerTree key={project.root} project={project} />;
}

/** Runs a tree operation, reporting a failure instead of letting it vanish into an unhandled rejection. */
async function attempt(what: string, op: () => Promise<void>) {
  try {
    await op();
  } catch (err) {
    reportError(`${what}: ${err}`);
  }
}

/** Cut or Copy in the explorer, waiting for a Paste — module-level so it survives the tree remounting. */
let explorerClipboard: { paths: string[]; cut: boolean } | null = null;

function joinPath(folder: string, name: string): string {
  return `${folder.replace(/[/\\]+$/, "")}/${name}`;
}

/** Windows Explorer's / Visual Studio's name for a pasted duplicate: `a - Copy.rs`, `a - Copy (2).rs`. */
function copyName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; ; n++) {
    const candidate = `${stem}${t(" - Copy")}${n > 1 ? ` (${n})` : ""}${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** The mod's id from `yog.toml` — new UI screens are named under it. */
async function modIdOf(project: ProjectInfo): Promise<string> {
  const id = await readModId(project.root);
  if (id) return id;
  return project.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
}

/**
 * Visual Studio's file nesting (`Form1.cs` ▸ `Form1.Designer.cs`, `Form1.resx`):
 * a screen's code-behind `foo.rs` goes under `foo.yui`, and a lock file under
 * its manifest.
 */
function nestParent(name: string, siblings: Set<string>): string | null {
  const lower = name.toLowerCase();
  const code = /^(.*)\.rs$/.exec(lower);
  if (code && siblings.has(`${code[1]}.yui`)) return `${code[1]}.yui`;
  // A resource set's culture variants under its neutral file: `Strings.ru_ru.yres` ▸ under `Strings.yres`.
  const culture = /^(.*)\.[a-z]{2,3}_[a-z0-9]{2,4}\.yres$/.exec(lower);
  if (culture && siblings.has(`${culture[1]}.yres`)) return `${culture[1]}.yres`;
  if (lower === "yog.lock") return "yog.toml";
  if (lower === "cargo.lock") return "cargo.toml";
  return null;
}

/**
 * Adds each screen's generated code (`.yog-build/generated/<path>.g.rs`, not
 * in the tree's folders) under its `.yui`, and each resource set's
 * (`.yog-build/generated/resources/<Set>.g.rs`) under its neutral `.yres`,
 * greyed — like Visual Studio showing `MainWindow.g.cs` under a XAML window
 * and `Resources.Designer.cs` under a `.resx`. Opens read-only.
 */
function withGeneratedCode(nodes: FileTreeNode[], root: string): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.kind === "folder") return node.children ? { ...node, children: withGeneratedCode(node.children, root) } : node;
    const generated = generatedCodePath(root, node.id);
    if (!generated) return node;
    const child: FileTreeNode = { id: generated, name: fileNameOf(generated), kind: "file", generated: true };
    return { ...node, nested: [...(node.nested ?? []), child] };
  });
}

/** The mod's `resources/` folder gets its own icon, like a C# project's Resources (files have their kind's — `fileTypes`). */
function withResourceIcons(nodes: FileTreeNode[], resourcesDir: string): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.kind === "folder") {
      const children = node.children && withResourceIcons(node.children, resourcesDir);
      const icon = node.id.replace(/\\/g, "/") === resourcesDir.replace(/\\/g, "/") ? <Icon name="folderTable" size={15} /> : node.icon;
      return children === node.children && icon === node.icon ? node : { ...node, children, icon };
    }
    const nested = node.nested && withResourceIcons(node.nested, resourcesDir);
    return nested === node.nested ? node : { ...node, nested };
  });
}

/** For `foo.yui` its code-behind `foo.rs`, and the other way round — F7 / Shift+F7 in Visual Studio. */
function codeBehindPair(path: string): { screen: string; code: string } | null {
  const m = /^(.*)\.(yui|rs)$/i.exec(path);
  if (!m || /\.designer$/i.test(m[1])) return null;
  return { screen: `${m[1]}.yui`, code: `${m[1]}.rs` };
}

const copyText = (text: string) =>
  navigator.clipboard.writeText(text).catch((err) => reportError(t("Couldn't copy to the clipboard: {error}", { error: String(err) })));

function ProjectExplorerTree({ project }: { project: ProjectInfo }) {
  // Expanded folders are remembered per project (see `WorkspaceProvider`).
  useT();
  const shell = useShell();
  const tree = useDirectoryTree(project.root, project.name, files, reportListError, "explorer.expanded");
  // Changes from outside (a terminal, git, a build) show up as they happen.
  useWatchedFolders(`explorer:${project.root}`, tree.loadedFolders);
  useFsChanged((paths) => void tree.refreshPaths(paths));
  const { tabs, pathRenamed, pathRemoved } = useOpenFiles();
  // Controlled, so a rename (here or from Properties) can carry the
  // selection over to the new path instead of losing it.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [newItem, setNewItem] = useState<{ folder: string; full: boolean } | null>(null);
  const backgroundMenu = useContextMenu<FileTreeNode>();
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const shownNodes = useMemo(() => {
    const nested = withResourceIcons(nestFiles(tree.nodes, nestParent), joinPath(project.root, "resources"));
    return project.kind === "yog-mod" ? withGeneratedCode(nested, project.root) : nested;
  }, [tree.nodes, project.kind, project.root]);

  // Properties' "File Name" renames through here while the path is in the
  // tree, so the tree re-lists its folder.
  useEffect(
    () =>
      registerExplorerRename(async (path, newName) => {
        const node = findNode(treeRef.current.nodes, path);
        if (!node) return false;
        await treeRef.current.renameNode(node, newName);
        const to = renamedPath(path, newName);
        setSelectedIds((prev) => new Set([...prev].map((id) => (isWithin(id, path) ? to + id.slice(path.length) : id))));
        return true;
      }),
    []
  );

  /** Makes this tree's selection the global one (what Properties shows). */
  function publishSelection(ids: Set<string>) {
    if (ids.size > 1) return selectMultiple(ids.size, "explorer");
    const [id] = ids;
    if (id === undefined) return;
    const node = findNode(tree.nodes, id);
    selectPath(id, node?.kind ?? "file", "explorer");
  }

  /** Coming back to the tree from elsewhere (an editor) makes its selection current again, as in Visual Studio. */
  function handleFocus(e: FocusEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) publishSelection(selectedIds);
  }

  const rootNode = (): FileTreeNode => findNode(tree.nodes, project.root) ?? { id: project.root, name: project.name, kind: "folder" };
  /** Where Add/Paste on `node` puts things — the folder itself, or a file's folder. */
  const folderOf = (node: FileTreeNode) => (node.kind === "folder" ? node.id : parentOf(node.id));
  /** What an action on `node` covers: the whole selection when `node` is part of it. */
  const targetsOf = (node: FileTreeNode) =>
    selectedIds.has(node.id) && selectedIds.size > 1 ? [...selectedIds].filter((id) => id !== project.root) : [node.id];

  function expand(folder: string) {
    if (!tree.expandedIds.has(folder)) tree.onExpandedChange(new Set([...tree.expandedIds, folder]));
  }

  async function takenNames(folder: string): Promise<Set<string>> {
    const entries = await files.list(folder);
    return new Set(entries.map((e) => e.name.toLowerCase()));
  }

  async function addFromTemplate(folder: string, template: ItemTemplate, name: string) {
    const modId = await modIdOf(project);
    if (template.rootFolder && folder === project.root) {
      // `.yres` files live in `resources/`, as a C# project's `.resx` in `Resources/`.
      const inner = joinPath(project.root, template.rootFolder);
      if (!(await takenNames(project.root)).has(template.rootFolder.toLowerCase())) await files.createDir(inner);
      await tree.reload(project.root);
      folder = inner;
    }
    const src = joinPath(project.root, "src");
    const srcDir = isWithin(folder, src) ? folder.slice(src.length + 1).replace(/\\/g, "/") : "";
    const created = templateFiles(template, name, { modId, srcDir });
    await attempt(t("Failed to create {name}", { name }), async () => {
      for (const [file, contents] of created) {
        const path = joinPath(folder, file);
        await files.createFile(path);
        if (contents) await files.write(path, contents);
      }
      await tree.reload(folder);
      expand(folder);
      // The first file is the one to work on (the screen, not its code-behind).
      openFile({ path: joinPath(folder, created[0][0]), name: created[0][0] });
    });
  }

  async function addPlain(folder: string, name: string, isFolder: boolean) {
    await attempt(t("Failed to create {name}", { name }), async () => {
      if (isFolder) await tree.createDirIn(folder, name);
      else {
        await tree.createFileIn(folder, name);
        openFile({ path: joinPath(folder, name), name });
      }
      expand(folder);
    });
  }

  async function addNewFolder(folder: string) {
    const name = await promptDialog({ title: t("New Folder"), label: t("Folder name"), confirmLabel: t("Create"), validate: validateName });
    if (name === null) return;
    await attempt(t("Failed to create {name}", { name: name.trim() }), async () => {
      await tree.createDirIn(folder, name.trim());
      expand(folder);
    });
  }

  /** Add > Existing Item (Shift+Alt+A): copies files picked from anywhere into `folder`. */
  async function addExisting(folder: string) {
    const picked = await openDialog({ multiple: true, title: t("Add Existing Item") });
    const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;
    await attempt(t("Failed to add files"), async () => {
      const taken = await takenNames(folder);
      for (const from of paths) {
        const name = copyName(fileNameOf(from), taken);
        taken.add(name.toLowerCase());
        await files.copy(from, joinPath(folder, name));
      }
      await tree.reload(folder);
      expand(folder);
    });
  }

  /** Moves (or with `copy`, copies) `paths` into `folder` — Paste after Cut/Copy, and drag and drop. */
  async function transfer(paths: string[], folder: string, copy: boolean) {
    await attempt(copy ? t("Failed to copy") : t("Failed to move"), async () => {
      const taken = await takenNames(folder);
      const touched = new Set([folder]);
      for (const from of paths) {
        if (!copy && isWithin(folder, from)) throw new Error(t("Can't move a folder into itself."));
        if (copy) {
          const name = copyName(fileNameOf(from), taken);
          taken.add(name.toLowerCase());
          await files.copy(from, joinPath(folder, name));
          continue;
        }
        if (parentOf(from) === folder.replace(/[/\\]+$/, "")) continue;
        const name = fileNameOf(from);
        if (taken.has(name.toLowerCase())) throw new Error(t('"{name}" already exists.', { name }));
        const to = joinPath(folder, name);
        await files.rename(from, to);
        taken.add(name.toLowerCase());
        touched.add(parentOf(from));
        // Open tabs and the selection follow it to the new place.
        pathRenamed(from, to);
        selectionPathRenamed(from, to);
        setSelectedIds((prev) => new Set([...prev].map((id) => (isWithin(id, from) ? to + id.slice(from.length) : id))));
      }
      for (const dir of touched) await tree.reload(dir);
      expand(folder);
    });
  }

  function cut(node: FileTreeNode) {
    explorerClipboard = { paths: targetsOf(node), cut: true };
  }

  function copy(node: FileTreeNode) {
    explorerClipboard = { paths: targetsOf(node), cut: false };
  }

  async function paste(node: FileTreeNode) {
    const clip = explorerClipboard;
    if (!clip) return;
    // Cut moves once; Copy can paste again.
    if (clip.cut) explorerClipboard = null;
    await transfer(clip.paths, folderOf(node), !clip.cut);
  }

  async function rename(node: FileTreeNode) {
    if (node.id === project.root) return;
    const name = await promptDialog({ title: t("Rename"), label: t("New name"), defaultValue: node.name, confirmLabel: t("Rename"), validate: validateName });
    if (name === null || name.trim() === node.name) return;
    // Open tabs and the selection under the old path follow it to the new one.
    await attempt(t("Failed to rename {name}", { name: node.name }), () => renamePath(node.id, name.trim(), pathRenamed));
  }

  async function remove(node: FileTreeNode) {
    const ids = targetsOf(node).filter((id) => id !== project.root);
    if (ids.length === 0) return;
    const only = ids.length === 1 ? findNode(tree.nodes, ids[0]) ?? node : null;
    const confirmed = await confirmDialog({
      title: only ? (only.kind === "folder" ? t("Delete Folder") : t("Delete File")) : t("Delete"),
      message: only
        ? only.kind === "folder"
          ? t('Delete "{name}" and everything in it?', { name: only.name })
          : t('Delete "{name}"?', { name: only.name })
        : t("Delete {count} items?", { count: ids.length }),
      confirmLabel: t("Delete"),
    });
    if (!confirmed) return;
    for (const id of ids) {
      const target = findNode(tree.nodes, id);
      if (!target) continue;
      await attempt(t("Failed to delete {name}", { name: target.name }), async () => {
        await tree.removeNode(target);
        pathRemoved(target.id);
        selectionPathRemoved(target.id);
        setSelectedIds((prev) => new Set([...prev].filter((sel) => !isWithin(sel, target.id))));
      });
    }
  }

  function showProperties(node: FileTreeNode) {
    if (node.id === project.root && project.kind === "yog-mod") return openProjectProperties();
    selectPath(node.id, node.kind, "explorer");
    shell.showToolWindow("properties");
  }

  function collapseDescendants(node: FileTreeNode) {
    tree.onExpandedChange(new Set([...tree.expandedIds].filter((id) => id === node.id || !isWithin(id, node.id))));
  }

  /** Solution Explorer's "Collapse All": every folder closes, the project node stays open. */
  function collapseAll() {
    tree.onExpandedChange(new Set([project.root]));
  }

  function openInTerminal(folder: string) {
    shell.showToolWindow("terminal");
    openTerminalIn(folder);
  }

  const relativePath = (path: string) => path.slice(project.root.replace(/[/\\]+$/, "").length + 1) || ".";

  function getMenuItems(node: FileTreeNode): FileTreeMenuItem[] {
    const isRoot = node.id === project.root;
    const folder = folderOf(node);
    const items: FileTreeMenuItem[] = [];
    // Generated code isn't a project file: it can only be looked at.
    if (node.generated) {
      return [
        { label: t("Open"), onSelect: (n) => openFile({ path: n.id, name: n.name }) },
        { label: t("Copy Full Path"), separatorBefore: true, onSelect: () => void copyText(node.id) },
      ];
    }
    if (node.kind === "file") {
      items.push({ label: t("Open"), onSelect: (n) => openFile({ path: n.id, name: n.name }) });
      const current = tabs.find((tab) => tab.path === node.id)?.view;
      items.push({
        label: t("Open With"),
        submenu: openWithItems(node.id, current, (view) => openFile({ path: node.id, name: node.name, view })),
      });
      // View Code (F7) / View Designer (Shift+F7): a screen's code-behind, else the file's own code or designer view.
      items.push({ label: t("View Code"), shortcut: "F7", onSelect: () => viewCode(node) });
      if (codeBehindPair(node.id) || designerView(node.id)) {
        items.push({ label: t("View Designer"), shortcut: "Shift+F7", onSelect: () => viewDesigner(node) });
      }
    }
    if (isRoot && project.kind === "yog-mod") {
      // Visual Studio's project node starts with Build/Clean.
      const run = (command: string, what: string) =>
        invoke(command, { projectRoot: project.root }).catch((err) => reportError(t("{action} failed to start: {error}", { action: what, error: String(err) })));
      items.push({ label: t("Build"), onSelect: () => void run("mod_build", t("Build")) });
      items.push({ label: t("Clean"), onSelect: () => void run("mod_clean", t("Clean")) });
    }
    if (node.kind === "folder") {
      items.push({
        label: t("Add"),
        separatorBefore: items.length > 0,
        submenu: [
          { label: t("New Item..."), shortcut: "Ctrl+Shift+A", onSelect: () => setNewItem({ folder, full: true }) },
          { label: t("Quick Add..."), onSelect: () => setNewItem({ folder, full: false }) },
          { label: t("Existing Item..."), shortcut: "Shift+Alt+A", onSelect: () => void addExisting(folder) },
          { label: t("New Folder"), separatorBefore: true, onSelect: () => void addNewFolder(folder) },
        ],
      });
    }
    items.push({
      label: node.kind === "folder" ? t("Open Folder in File Explorer") : t("Open Containing Folder"),
      separatorBefore: true,
      onSelect: () =>
        void (node.kind === "folder" ? openPath(node.id) : revealItemInDir(node.id)).catch((err) =>
          reportError(t("Couldn't open {path}: {error}", { path: node.id, error: String(err) }))
        ),
    });
    items.push({ label: t("Open in Terminal"), onSelect: () => openInTerminal(folder) });
    if (!isRoot) {
      items.push({ label: t("Cut"), shortcut: "Ctrl+X", separatorBefore: true, onSelect: cut });
      items.push({ label: t("Copy"), shortcut: "Ctrl+C", onSelect: copy });
    }
    items.push({ label: t("Paste"), shortcut: "Ctrl+V", separatorBefore: isRoot, disabled: !explorerClipboard, onSelect: (n) => void paste(n) });
    if (!isRoot) {
      items.push({ label: t("Delete"), shortcut: "Delete", destructive: true, onSelect: (n) => void remove(n) });
      items.push({ label: t("Rename"), shortcut: "F2", onSelect: (n) => void rename(n) });
    }
    items.push({ label: t("Copy Full Path"), separatorBefore: true, onSelect: (n) => void copyText(n.id) });
    if (!isRoot) items.push({ label: t("Copy Relative Path"), onSelect: (n) => void copyText(relativePath(n.id)) });
    if (node.kind === "folder") items.push({ label: t("Collapse All Descendants"), separatorBefore: true, onSelect: collapseDescendants });
    items.push({ label: t("Collapse All"), separatorBefore: node.kind !== "folder", onSelect: collapseAll });
    items.push({ label: t("Properties"), shortcut: "Alt+Enter", separatorBefore: true, onSelect: showProperties });
    return items;
  }

  /** A screen and its code-behind both in the tree. */
  function pairOf(node: FileTreeNode) {
    const pair = codeBehindPair(node.id);
    const siblings = findNode(tree.nodes, parentOf(node.id))?.children ?? [];
    return pair && siblings.some((n) => n.id === pair.screen) && siblings.some((n) => n.id === pair.code) ? pair : null;
  }

  /** The file's designer view (`.yui`, `.yblock`…), if it has one. */
  function designerView(path: string) {
    return editorProvidersFor(path).find((p) => p.kind === "designer");
  }

  /** F7, as in Visual Studio: a screen's code-behind, else the file in a code editor. */
  function viewCode(node: FileTreeNode) {
    if (node.kind !== "file") return;
    const pair = pairOf(node);
    if (pair && node.id === pair.screen) {
      openFile({ path: pair.code, name: fileNameOf(pair.code) });
      return;
    }
    const code = editorProvidersFor(node.id).find((p) => p.kind === "text") ?? generalEditorProviders().find((p) => p.kind === "text");
    openFile({ path: node.id, name: node.name, view: code?.id });
  }

  /** Shift+F7: a code-behind's screen, else the file's designer. */
  function viewDesigner(node: FileTreeNode) {
    if (node.kind !== "file") return;
    const pair = pairOf(node);
    if (pair && node.id === pair.code) {
      openFile({ path: pair.screen, name: fileNameOf(pair.screen) });
      return;
    }
    const designer = designerView(node.id);
    if (designer) openFile({ path: node.id, name: node.name, view: designer.id });
  }

  /** The node keyboard commands act on — the last selected one. */
  function focusedNode(): FileTreeNode | null {
    const id = [...selectedIds].pop();
    return id === undefined ? null : findNode(tree.nodes, id);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    const node = focusedNode() ?? rootNode();
    const commands: [string, () => void][] = [
      ["F2", () => void rename(node)],
      ["Delete", () => void remove(node)],
      ["Ctrl+X", () => node.id !== project.root && cut(node)],
      ["Ctrl+C", () => node.id !== project.root && copy(node)],
      ["Ctrl+V", () => void paste(node)],
      ["Ctrl+Shift+A", () => setNewItem({ folder: folderOf(node), full: false })],
      ["Shift+Alt+A", () => void addExisting(folderOf(node))],
      ["Alt+Enter", () => showProperties(node)],
      ["F7", () => viewCode(node)],
      ["Shift+F7", () => viewDesigner(node)],
    ];
    const hit = commands.find(([keys]) => matchesShortcut(e.nativeEvent, keys));
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    hit[1]();
  }

  /** Right-click below the rows: the project node's menu, as in Solution Explorer (not the webview's own). */
  function handleBackgroundContextMenu(e: MouseEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    backgroundMenu.openAtPoint(rootNode(), e);
  }

  const backgroundItems = (items: FileTreeMenuItem[], node: FileTreeNode): ContextMenuItem[] =>
    items.map(({ onSelect, submenu, ...item }) => ({
      ...item,
      onSelect: onSelect && (() => onSelect(node)),
      submenu: submenu && backgroundItems(submenu, node),
    }));

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Toolbar sections={[[{ icon: "collapse", label: t("Collapse All"), onClick: collapseAll }]]} />
      <div
        className="project-explorer"
        style={{ flex: "1 1 0", minHeight: 0, overflow: "auto", padding: "var(--sp-space-xs)", boxSizing: "border-box" }}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        onContextMenu={handleBackgroundContextMenu}
      >
        <FileTree
          nodes={shownNodes}
          expandedIds={tree.expandedIds}
          onExpandedChange={tree.onExpandedChange}
          selectedIds={selectedIds}
          onSelectionChange={(ids) => {
            setSelectedIds(ids);
            publishSelection(ids);
          }}
          onActivate={(node) => openFile({ path: node.id, name: node.name })}
          getMenuItems={getMenuItems}
          canDrag={(node) => node.id !== project.root && !node.generated}
          onDropNodes={(ids, folder, copyDrop) => void transfer(ids, folder.id, copyDrop)}
        />
        <ContextMenu
          target={backgroundMenu.target?.mode === "viewport" ? backgroundMenu.target : null}
          items={backgroundMenu.target ? backgroundItems(getMenuItems(backgroundMenu.target.node), backgroundMenu.target.node) : []}
          onClose={backgroundMenu.close}
        />
        {newItem && (
          <NewItemDialog
            folder={newItem.folder}
            full={newItem.full}
            onAdd={(template, name) => addFromTemplate(newItem.folder, template, name)}
            onAddPlain={(name, isFolder) => addPlain(newItem.folder, name, isFolder)}
            onClose={() => setNewItem(null)}
          />
        )}
      </div>
    </div>
  );
}

function findNode(nodes: FileTreeNode[], id: string): FileTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const inner = node.children ? findNode(node.children, id) : null;
    if (inner) return inner;
  }
  return null;
}
