import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ContextMenu,
  FileTree,
  SearchField,
  Toolbar,
  ToolbarButton,
  ToolbarGroup,
  confirmDialog,
  editorProvidersFor,
  fileTreeFromEntries,
  filterFileTree,
  generalEditorProviders,
  matchesShortcut,
  nestFiles,
  openTerminalIn,
  useContextMenu,
  useDirectoryTree,
  useShell,
  useStoredState,
  t,
  useT,
  withShortcut,
  type ContextMenuItem,
  type FileTreeMenuItem,
  type FileTreeNode,
  fileNameOf,
  joinPath,
} from "substrate-platform-ui";
import { useProject, type ProjectInfo } from "../ProjectContext";
import { openWithItems, useActiveFileTab, useOpenFiles } from "../OpenFilesContext";
import { openFile } from "../fileOpenBus";
import { reportError } from "../reportError";
import { EVENT, emitTo } from "../events";
import { generatedCodePath, isWithin, parentOf, renamedPath, validateEntryName as validateName } from "../paths";
import { openProjectProperties } from "../projectProperties/bus";
import { registerExplorerRename, renamePath, selectionPathRemoved, selectionPathRenamed, selectMultiple, selectPath } from "../ideSelection";
import { NewItemDialog, templateFiles, type ItemTemplate } from "./NewItemDialog";
import { files, readModId } from "../files";
import { useFsChanged, useWatchedFolders } from "../fsWatch";
import { refreshGit, useGit } from "../git/gitStore";
import { changeKindLabel, changeLetter, type ChangeKind, type RepoStatus } from "../git/gitApi";
import { boundCommands, commandLabel, explorerCommand, type ExplorerCommandId } from "./explorer/commands";
import { PROJECT_EXPLORER_VIEW_PANEL, openExplorerView, useExplorerRequests, useExplorerView } from "./explorer/explorerBus";
import { useContentMatches, useProjectItems } from "./explorer/projectItems";
import {
  explorerMatch,
  findNode,
  nestParent,
  pathTo,
  placeholderId,
  withChangeMarks,
  withFaded,
  withGeneratedCode,
  withPlaceholder,
  withProjectItems,
  withResourceIcons,
} from "./explorer/projectTree";
import "../git/git.css";
import "./explorer/explorer.css";

/** A folder that failed to list stays unloaded in the tree (expanding it again retries) — say why in Output rather than only the devtools console. */
function reportListError(error: unknown, path: string) {
  emitTo(EVENT.ideOutput, `[error] failed to list ${path}: ${error}`);
}

function NoProject() {
  const t = useT();
  const { error } = useProject();
  return (
    <div className="idle-explorer-message">
      {error ? t("Failed to open project: {error}", { error }) : t("No project open — use File > Open Project or Open Folder.")}
    </div>
  );
}

/** The Project Explorer tool window. */
export function ProjectExplorer() {
  const { project } = useProject();
  if (!project) return <NoProject />;
  return <ProjectExplorerTree key={project.root} project={project} main />;
}

/** New Project Explorer View: a second explorer, scoped to the folder it was opened on. */
export function ProjectExplorerView() {
  const t = useT();
  const { project } = useProject();
  const request = useExplorerView();
  if (!project) return <NoProject />;
  if (!request || !isWithin(request.root, project.root)) {
    return <div className="idle-explorer-message">{t("Use New Project Explorer View on a folder in Project Explorer.")}</div>;
  }
  return <ProjectExplorerTree key={`${project.root}\u0000${request.seq}`} project={project} initialScope={request.root} />;
}

/** Runs a tree operation, reporting a failure instead of letting it vanish into an unhandled rejection. */
async function attempt(what: string, op: () => Promise<void>) {
  try {
    await op();
  } catch (err) {
    reportError(`${what}: ${err}`);
  }
}

/** Cut or Copy in the explorer, waiting for a Paste — module-level so it survives the tree remounting, and shared by every view. */
let explorerClipboard: { paths: string[]; cut: boolean } | null = null;

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

/** For `foo.yui` its code-behind `foo.rs`, and the other way round — F7 / Shift+F7 in Visual Studio. */
function codeBehindPair(path: string): { screen: string; code: string } | null {
  const m = /^(.*)\.(yui|rs)$/i.exec(path);
  if (!m || /\.designer$/i.test(m[1])) return null;
  return { screen: `${m[1]}.yui`, code: `${m[1]}.rs` };
}

const copyText = (text: string) =>
  navigator.clipboard.writeText(text).catch((err) => reportError(t("Couldn't copy to the clipboard: {error}", { error: String(err) })));

/** The generated files (`generatedCodePath`) of the tree's screens and resource sets that exist — re-checked as files change and when the window comes back. */
function useGeneratedCode(project: ProjectInfo, nodes: FileTreeNode[]): ReadonlySet<string> {
  const [exists, setExists] = useState<ReadonlySet<string>>(new Set());
  const [checks, setChecks] = useState(0);
  const candidates = useMemo(() => {
    if (project.kind !== "yog-mod") return [];
    const out: string[] = [];
    const walk = (list: FileTreeNode[]) => {
      for (const n of list) {
        if (n.kind === "folder") walk(n.children ?? []);
        else {
          const g = generatedCodePath(project.root, n.id);
          if (g) out.push(g);
        }
      }
    };
    walk(nodes);
    return out;
  }, [project.kind, project.root, nodes]);
  const key = candidates.join("\n");
  useEffect(() => {
    let live = true;
    void Promise.all(candidates.map((p) => files.info(p).then((i) => (i.kind === "file" ? p : null), () => null))).then((found) => {
      if (!live) return;
      const next = new Set(found.filter((p): p is string => !!p));
      setExists((cur) => (cur.size === next.size && [...next].every((p) => cur.has(p)) ? cur : next));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, checks]);
  useFsChanged(() => setChecks((n) => n + 1));
  useEffect(() => {
    const again = () => setChecks((n) => n + 1);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);
  return exists;
}

/** Each changed file's status in the working tree, the worst of its staged and unstaged changes (deleted files aren't in the tree). */
function changedFiles(status: RepoStatus | null): Map<string, ChangeKind> {
  const out = new Map<string, ChangeKind>();
  if (!status) return out;
  for (const change of [...status.staged, ...status.unstaged, ...status.conflicted]) {
    if (change.kind !== "deleted") out.set(change.absPath, change.kind);
  }
  return out;
}

/** Open Files and Pending Changes, Solution Explorer's two filters. */
type ListFilter = "filterOpenFiles" | "filterPendingChanges";

/** What's being typed into a row: a rename, or a new item's name. */
type Editing = { kind: "rename"; id: string } | { kind: "new"; folder: string; isFolder: boolean };

/** Scope to This: the folder the tree is rooted at, with Back/Forward history. */
interface ScopeHistory {
  stack: string[];
  at: number;
}

function ProjectExplorerTree({ project, initialScope, main = false }: { project: ProjectInfo; initialScope?: string; main?: boolean }) {
  useT();
  const shell = useShell();
  const [scopes, setScopes] = useState<ScopeHistory>({ stack: [initialScope ?? project.root], at: 0 });
  const scopeRoot = scopes.stack[scopes.at];
  const scoped = scopeRoot !== project.root;
  // Expanded folders are remembered per project (see `WorkspaceProvider`) — the main view's, unscoped.
  const tree = useDirectoryTree(scopeRoot, scoped ? fileNameOf(scopeRoot) : project.name, files, reportListError, main && !scoped ? "explorer.expanded" : undefined);
  // Changes from outside (a terminal, git, a build) show up as they happen.
  useWatchedFolders(`explorer:${main ? "main" : "view"}:${project.root}`, tree.loadedFolders);
  useFsChanged((paths) => void tree.refreshPaths(paths));
  const { tabs, pathRenamed, pathRemoved } = useOpenFiles();
  const activeTab = useActiveFileTab();
  const git = useGit();
  // Controlled, so a rename (here or from Properties) can carry the
  // selection over to the new path instead of losing it.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [newItem, setNewItem] = useState<{ folder: string; full: boolean } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [query, setQuery] = useState("");
  const [listFilter, setListFilter] = useState<ListFilter | null>(null);
  const [showAllFiles, setShowAllFiles] = useStoredState("explorer.showAllFiles", false, (v) => typeof v === "boolean");
  const [trackActive, setTrackActive] = useStoredState("explorer.trackActive", false, (v) => typeof v === "boolean");
  const [searchContents, setSearchContents] = useStoredState("explorer.searchContents", false, (v) => typeof v === "boolean");
  /** Bumped by the explorer's own changes on disk, so the project listing is re-read. */
  const [revision, setRevision] = useState(0);
  /** Bumped when Cut/Copy change what's on the explorer's clipboard (cut items are drawn dimmed). */
  const [, setClipboardSeq] = useState(0);
  const [reveal, setReveal] = useState<{ id: string } | null>(null);
  /** Sync with Active Document waiting for the folders down to the file to be listed. */
  const [pendingReveal, setPendingReveal] = useState<{ path: string; listed: boolean; select: boolean } | null>(null);
  const backgroundMenu = useContextMenu<FileTreeNode>();
  const filterMenu = useContextMenu<null>();
  const searchRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef(tree);
  treeRef.current = tree;

  const entries = useProjectItems(project.root, revision);
  const projectItems = useMemo(() => (entries ? new Set(entries.map((e) => e.path)) : null), [entries]);
  const contentHits = useContentMatches(scopeRoot, query, searchContents, revision);
  const changed = useMemo(() => changedFiles(git.status), [git.status]);
  const only = useMemo(
    () => (listFilter === "filterOpenFiles" ? new Set(tabs.map((tab) => tab.path)) : listFilter === "filterPendingChanges" ? new Set(changed.keys()) : null),
    [listFilter, tabs, changed]
  );
  const filtering = query.trim() !== "" || listFilter !== null;

  // While searching or filtering, the whole project at once (the lazily listed tree only knows the folders opened so far).
  const baseNodes = useMemo(() => {
    if (!filtering || !entries) return withProjectItems(tree.nodes, scopeRoot, projectItems, showAllFiles);
    return fileTreeFromEntries(scopeRoot, tree.nodes[0]?.name ?? project.name, entries.filter((e) => e.path !== scopeRoot && isWithin(e.path, scopeRoot)));
  }, [filtering, entries, tree.nodes, scopeRoot, projectItems, showAllFiles, project.name]);
  const generated = useGeneratedCode(project, baseNodes);
  const decorated = useMemo(() => {
    let nodes = withResourceIcons(nestFiles(baseNodes, nestParent), joinPath(project.root, "resources"));
    if (project.kind === "yog-mod") nodes = withGeneratedCode(nodes, project.root, generated);
    return withChangeMarks(
      nodes,
      changed,
      (kind) => (
        <span className={`idle-git-letter idle-git-kind-${kind}`} title={t(changeKindLabel(kind as ChangeKind))}>
          {changeLetter(kind as ChangeKind)}
        </span>
      ),
      <span className="idle-explorer-changed-folder" title={t("Contains changes")} />
    );
  }, [baseNodes, project.kind, project.root, generated, changed]);
  const filtered = useMemo(() => (filtering ? filterFileTree(decorated, explorerMatch({ query, contentHits, only })) : null), [filtering, decorated, query, contentHits, only]);

  // A filtered tree opens on its matches; what's opened or closed in it after that is its own.
  const filterKey = `${query}\u0000${listFilter}\u0000${filtered?.count ?? 0}`;
  const [filterExpanded, setFilterExpanded] = useState<{ key: string; ids: Set<string> } | null>(null);
  const expandedIds = filtered
    ? filterExpanded?.key === filterKey
      ? filterExpanded.ids
      : new Set([scopeRoot, ...filtered.expandedIds])
    : tree.expandedIds;
  const onExpandedChange = (ids: Set<string>) => (filtered ? setFilterExpanded({ key: filterKey, ids }) : tree.onExpandedChange(ids));

  const clip = explorerClipboard;
  const shownNodes = useMemo(() => {
    let nodes = filtered?.nodes ?? decorated;
    if (clip?.cut) nodes = withFaded(nodes, clip.paths);
    if (editing?.kind === "new") nodes = withPlaceholder(nodes, editing.folder, editing.isFolder ? "folder" : "file");
    return nodes;
  }, [filtered, decorated, clip, editing]);

  // Properties' "File Name" renames through here while the path is in the
  // tree, so the tree re-lists its folder.
  useEffect(() => {
    if (!main) return;
    return registerExplorerRename(async (path, newName) => {
      const node = findNode(treeRef.current.nodes, path);
      if (!node) return false;
      await treeRef.current.renameNode(node, newName);
      const to = renamedPath(path, newName);
      setSelectedIds((prev) => new Set([...prev].map((id) => (isWithin(id, path) ? to + id.slice(path.length) : id))));
      return true;
    });
  }, [main]);

  /** Makes this tree's selection the global one (what Properties shows). */
  function publishSelection(ids: Set<string>) {
    if (ids.size > 1) return selectMultiple(ids.size, "explorer");
    const [id] = ids;
    if (id === undefined) return;
    const node = findNode(shownNodes, id);
    selectPath(id, node?.kind ?? "file", "explorer");
  }

  /** Coming back to the tree from elsewhere (an editor) makes its selection current again, as in Visual Studio. */
  function handleFocus(e: FocusEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) publishSelection(selectedIds);
  }

  /** Something the explorer itself did changed the disk: re-read what depends on it. */
  const changedDisk = () => setRevision((n) => n + 1);

  const rootNode = (): FileTreeNode => findNode(shownNodes, scopeRoot) ?? { id: scopeRoot, name: fileNameOf(scopeRoot), kind: "folder" };
  const isRoot = (node: FileTreeNode) => node.id === scopeRoot;
  /** Where Add/Paste on `node` puts things — the folder itself, or a file's folder. */
  const folderOf = (node: FileTreeNode) => (node.kind === "folder" ? node.id : parentOf(node.id));
  /** What an action on `node` covers: the whole selection when `node` is part of it. */
  const targetsOf = (node: FileTreeNode) =>
    selectedIds.has(node.id) && selectedIds.size > 1 ? [...selectedIds].filter((id) => id !== scopeRoot) : [node.id];

  function expand(folder: string) {
    if (!expandedIds.has(folder)) onExpandedChange(new Set([...expandedIds, folder]));
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
      changedDisk();
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
      changedDisk();
      expand(folder);
      const path = joinPath(folder, name);
      setSelectedIds(new Set([path]));
      setReveal({ id: path });
    });
  }

  /** New File / New Folder: an empty row in `folder` to type the name into. */
  function startNew(folder: string, isFolder: boolean) {
    if (filtering) {
      // The row goes into the full tree; the search or filter would hide it.
      setQuery("");
      setListFilter(null);
      void tree.revealPath(placeholderId(folder));
    } else expand(folder);
    setEditing({ kind: "new", folder, isFolder });
    setReveal({ id: placeholderId(folder) });
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
      changedDisk();
      expand(folder);
    });
  }

  /** Moves (or with `copy`, copies) `paths` into `folder` — Paste after Cut/Copy, Duplicate, and drag and drop. */
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
      changedDisk();
      expand(folder);
    });
  }

  function putOnClipboard(node: FileTreeNode, cut: boolean) {
    if (isRoot(node) || node.generated) return;
    explorerClipboard = { paths: targetsOf(node), cut };
    setClipboardSeq((n) => n + 1);
  }

  async function paste(node: FileTreeNode) {
    const clip = explorerClipboard;
    if (!clip) return;
    // Cut moves once; Copy can paste again.
    if (clip.cut) {
      explorerClipboard = null;
      setClipboardSeq((n) => n + 1);
    }
    await transfer(clip.paths, folderOf(node), !clip.cut);
  }

  /** Duplicate: a copy of each item next to it, named as a pasted copy is. */
  async function duplicate(node: FileTreeNode) {
    if (isRoot(node) || node.generated) return;
    const byFolder = new Map<string, string[]>();
    for (const path of targetsOf(node)) byFolder.set(parentOf(path), [...(byFolder.get(parentOf(path)) ?? []), path]);
    for (const [folder, paths] of byFolder) await transfer(paths, folder, true);
  }

  /** F2: the name becomes editable in place. */
  function startRename(node: FileTreeNode) {
    if (isRoot(node) || node.generated) return;
    setEditing({ kind: "rename", id: node.id });
  }

  async function commitEdit(node: FileTreeNode, text: string) {
    const current = editing;
    setEditing(null);
    if (!current) return;
    const name = text.trim();
    const problem = validateName(text);
    if (current.kind === "new") {
      if (problem === "") return;
      if (problem) return reportError(problem);
      await addPlain(current.folder, name, current.isFolder);
      return;
    }
    if (problem === "" || name === node.name) return;
    if (problem) return reportError(problem);
    // Open tabs and the selection under the old path follow it to the new one.
    await attempt(t("Failed to rename {name}", { name: node.name }), async () => {
      await renamePath(node.id, name, pathRenamed);
      changedDisk();
      // Another view's rename doesn't go through this tree's `renameNode`.
      await tree.reload(parentOf(node.id));
    });
  }

  async function remove(node: FileTreeNode) {
    const ids = targetsOf(node).filter((id) => id !== scopeRoot && !findNode(shownNodes, id)?.generated);
    if (ids.length === 0) return;
    const only = ids.length === 1 ? findNode(shownNodes, ids[0]) ?? node : null;
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
      const target = findNode(tree.nodes, id) ?? findNode(shownNodes, id);
      if (!target) continue;
      await attempt(t("Failed to delete {name}", { name: target.name }), async () => {
        if (findNode(tree.nodes, id)) await tree.removeNode(target);
        else {
          await files.remove(id);
          await tree.reload(parentOf(id));
        }
        pathRemoved(target.id);
        selectionPathRemoved(target.id);
        setSelectedIds((prev) => new Set([...prev].filter((sel) => !isWithin(sel, target.id))));
      });
    }
    changedDisk();
  }

  function showProperties(node: FileTreeNode) {
    if (node.id === project.root && project.kind === "yog-mod") return openProjectProperties();
    selectPath(node.id, node.kind, "explorer");
    shell.showToolWindow("properties");
  }

  function collapseDescendants(node: FileTreeNode) {
    onExpandedChange(new Set([...expandedIds].filter((id) => id === node.id || !isWithin(id, node.id))));
  }

  /** Solution Explorer's "Collapse All": every folder closes, the root node stays open. */
  function collapseAll() {
    onExpandedChange(new Set([scopeRoot]));
  }

  function openInTerminal(folder: string) {
    shell.showToolWindow("terminal");
    openTerminalIn(folder);
  }

  function openInFileExplorer(node: FileTreeNode) {
    void (node.kind === "folder" ? openPath(node.id) : revealItemInDir(node.id)).catch((err) =>
      reportError(t("Couldn't open {path}: {error}", { path: node.id, error: String(err) }))
    );
  }

  const relativePath = (path: string) => path.slice(project.root.replace(/[/\\]+$/, "").length + 1) || ".";

  /** Scope to This: the tree rooted at `folder`, Back returning to where it was. */
  function scopeTo(folder: string) {
    if (folder === scopeRoot) return;
    setQuery("");
    setListFilter(null);
    setScopes(({ stack, at }) => ({ stack: [...stack.slice(0, at + 1), folder], at: at + 1 }));
  }

  /**
   * Sync with Active Document: the file's folders opened and its row
   * selected and scrolled to. A search or filter hiding it is cleared.
   */
  function syncTo(path: string, select: boolean) {
    if (!isWithin(path, scopeRoot)) return;
    if (filtering && !pathTo(shownNodes, path)) {
      setQuery("");
      setListFilter(null);
    }
    setPendingReveal({ path, listed: false, select });
    void tree.revealPath(path).then(() => setPendingReveal((p) => (p?.path === path ? { ...p, listed: true } : p)));
  }

  useEffect(() => {
    if (!pendingReveal) return;
    const chain = pathTo(shownNodes, pendingReveal.path);
    if (!chain) {
      // Not in the tree (hidden, not part of the project) once its folders are listed: nothing to show.
      if (pendingReveal.listed) setPendingReveal(null);
      return;
    }
    const closed = chain.filter((id) => !expandedIds.has(id));
    if (closed.length > 0) onExpandedChange(new Set([...expandedIds, ...closed]));
    const ids = new Set([pendingReveal.path]);
    setSelectedIds(ids);
    if (pendingReveal.select) publishSelection(ids);
    setReveal({ id: pendingReveal.path });
    setPendingReveal(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReveal, shownNodes]);

  // Track Active Item: the tree follows the editor — without taking Properties over from it.
  const activePath = activeTab?.path;
  useEffect(() => {
    if (trackActive && activePath) syncTo(activePath, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackActive, activePath]);

  async function refresh() {
    await tree.refreshAll();
    changedDisk();
    void refreshGit();
  }

  function focusSearch() {
    searchRef.current?.focus();
    searchRef.current?.select();
  }

  function toggleFilter(filter: ListFilter) {
    setListFilter((current) => (current === filter ? null : filter));
  }

  /** The node keyboard commands act on — the last selected one, else the root. */
  function focusedNode(): FileTreeNode {
    const id = [...selectedIds].pop();
    return (id !== undefined && findNode(shownNodes, id)) || rootNode();
  }

  /** What each command does to the node it's invoked on (the focused one, from the toolbar and the keyboard). */
  const run: Record<ExplorerCommandId, (node: FileTreeNode) => void> = {
    open: (n) => n.kind === "file" && openFile({ path: n.id, name: n.name }),
    openWith: () => {},
    viewCode: (n) => viewCode(n),
    viewDesigner: (n) => viewDesigner(n),
    build: () => void runBuild("mod_build", t("Build")),
    clean: () => void runBuild("mod_clean", t("Clean")),
    add: () => {},
    newItem: (n) => setNewItem({ folder: folderOf(n), full: true }),
    quickAdd: (n) => setNewItem({ folder: folderOf(n), full: false }),
    addExisting: (n) => void addExisting(folderOf(n)),
    newFile: (n) => startNew(folderOf(n), false),
    newFolder: (n) => startNew(folderOf(n), true),
    scopeToThis: (n) => n.kind === "folder" && scopeTo(n.id),
    newView: (n) => {
      openExplorerView(folderOf(n));
      shell.showToolWindow(PROJECT_EXPLORER_VIEW_PANEL);
    },
    openFolderInFileExplorer: openInFileExplorer,
    openContainingFolder: openInFileExplorer,
    openInTerminal: (n) => openInTerminal(folderOf(n)),
    cut: (n) => putOnClipboard(n, true),
    copy: (n) => putOnClipboard(n, false),
    paste: (n) => void paste(n),
    duplicate: (n) => void duplicate(n),
    delete: (n) => void remove(n),
    rename: startRename,
    copyFullPath: (n) => void copyText(n.id),
    copyRelativePath: (n) => void copyText(relativePath(n.id)),
    collapseDescendants,
    collapseAll,
    properties: showProperties,
    back: () => setScopes((s) => ({ ...s, at: Math.max(0, s.at - 1) })),
    forward: () => setScopes((s) => ({ ...s, at: Math.min(s.stack.length - 1, s.at + 1) })),
    home: () => scopeTo(project.root),
    syncActive: () => activePath && syncTo(activePath, true),
    trackActive: () => setTrackActive((on) => !on),
    showAllFiles: () => setShowAllFiles((on) => !on),
    filters: () => {},
    filterOpenFiles: () => toggleFilter("filterOpenFiles"),
    filterPendingChanges: () => toggleFilter("filterPendingChanges"),
    refresh: () => void refresh(),
    search: focusSearch,
    searchContents: () => setSearchContents((on) => !on),
  };

  // Ctrl+; and the Ctrl+[ chords, pressed anywhere — for the main view.
  useExplorerRequests((id) => {
    // After the window has come up and laid out.
    requestAnimationFrame(() => run[id](focusedNode()));
  }, main);

  function runBuild(command: string, what: string) {
    return invoke(command, { projectRoot: project.root }).catch((err) => reportError(t("{action} failed to start: {error}", { action: what, error: String(err) })));
  }

  /** A menu entry for a command — its name and shortcut from the table, run on `node`. */
  function item(id: ExplorerCommandId, node: FileTreeNode, extra: Partial<FileTreeMenuItem> = {}): FileTreeMenuItem {
    return { label: commandLabel(id), shortcut: explorerCommand(id).shortcut, onSelect: () => run[id](node), ...extra };
  }

  function getMenuItems(node: FileTreeNode): FileTreeMenuItem[] {
    if (node.id === placeholderId(parentOf(node.id))) return [];
    const root = isRoot(node);
    const items: FileTreeMenuItem[] = [];
    // Generated code isn't a project file: it can only be looked at.
    if (node.generated) {
      return [item("open", node), item("openContainingFolder", node, { separatorBefore: true }), item("copyFullPath", node)];
    }
    if (node.kind === "file") {
      items.push(item("open", node));
      const current = tabs.find((tab) => tab.path === node.id)?.view;
      items.push(item("openWith", node, { onSelect: undefined, submenu: openWithItems(node.id, current, (view) => openFile({ path: node.id, name: node.name, view })) }));
      // View Code (F7) / View Designer (Shift+F7): a screen's code-behind, else the file's own code or designer view.
      items.push(item("viewCode", node));
      if (codeBehindPair(node.id) || designerView(node.id)) items.push(item("viewDesigner", node));
    }
    if (node.id === project.root && project.kind === "yog-mod") {
      // Visual Studio's project node starts with Build/Clean.
      items.push(item("build", node));
      items.push(item("clean", node));
    }
    if (node.kind === "folder") {
      items.push(
        item("add", node, {
          onSelect: undefined,
          separatorBefore: items.length > 0,
          submenu: [
            item("newItem", node),
            item("quickAdd", node),
            item("addExisting", node),
            item("newFile", node, { separatorBefore: true }),
            item("newFolder", node),
          ],
        })
      );
      if (!root) items.push(item("scopeToThis", node));
      items.push(item("newView", node, { separatorBefore: root }));
    }
    items.push(item(node.kind === "folder" ? "openFolderInFileExplorer" : "openContainingFolder", node, { separatorBefore: true }));
    items.push(item("openInTerminal", node));
    if (!root) {
      items.push(item("cut", node, { separatorBefore: true }));
      items.push(item("copy", node));
    }
    items.push(item("paste", node, { separatorBefore: root, disabled: !explorerClipboard }));
    if (!root) {
      items.push(item("duplicate", node));
      items.push(item("delete", node, { destructive: true }));
      items.push(item("rename", node));
    }
    items.push(item("copyFullPath", node, { separatorBefore: true }));
    if (node.id !== project.root) items.push(item("copyRelativePath", node));
    if (node.kind === "folder") items.push(item("collapseDescendants", node, { separatorBefore: true }));
    items.push(item("collapseAll", node, { separatorBefore: node.kind !== "folder" }));
    items.push(item("properties", node, { separatorBefore: true }));
    return items;
  }

  /** A screen and its code-behind both in the tree. */
  function pairOf(node: FileTreeNode) {
    const pair = codeBehindPair(node.id);
    if (!pair) return null;
    const exists = (path: string) => !!findNode(shownNodes, path) || !!projectItems?.has(path);
    return exists(pair.screen) && exists(pair.code) ? pair : null;
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

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    const hit = boundCommands(false).find(([, command]) => matchesShortcut(e.nativeEvent, command.shortcut));
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    run[hit[0]](focusedNode());
  }

  /** Right-click below the rows: the root node's menu, as in Solution Explorer (not the webview's own). */
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

  /** A toolbar button for a command — its icon, name and shortcut from the table. */
  function button(id: ExplorerCommandId, extra: { active?: boolean; disabled?: boolean; dropdown?: boolean; onClick?: (e: MouseEvent<HTMLButtonElement>) => void } = {}) {
    const command = explorerCommand(id);
    return <ToolbarButton key={id} icon={command.icon} label={commandLabel(id)} shortcut={command.shortcut} onClick={() => run[id](focusedNode())} {...extra} />;
  }

  const filterItems: ContextMenuItem[] = (["filterOpenFiles", "filterPendingChanges"] as const).map((id) => ({
    label: commandLabel(id),
    shortcut: explorerCommand(id).shortcut,
    checked: listFilter === id,
    disabled: id === "filterPendingChanges" && !git.status,
    onSelect: () => toggleFilter(id),
  }));

  const searchCommand = explorerCommand("search");
  const empty = filtered && filtered.nodes.length === 0;

  return (
    <div className="idle-explorer">
      <Toolbar>
        <ToolbarGroup>
          {button("back", { disabled: scopes.at === 0 })}
          {button("forward", { disabled: scopes.at >= scopes.stack.length - 1 })}
          {button("home", { disabled: !scoped })}
        </ToolbarGroup>
        <ToolbarGroup>
          {button("filters", { active: listFilter !== null, dropdown: true, onClick: (e) => filterMenu.openAtPoint(null, e) })}
          {button("syncActive", { disabled: !activePath || !isWithin(activePath, scopeRoot) })}
          {button("trackActive", { active: trackActive })}
          {button("refresh")}
          {button("collapseAll")}
          {button("showAllFiles", { active: showAllFiles })}
          {button("properties")}
        </ToolbarGroup>
      </Toolbar>
      <ContextMenu target={filterMenu.target?.mode === "viewport" ? filterMenu.target : null} items={filterItems} onClose={filterMenu.close} />
      <div className="idle-explorer-search">
        <SearchField
          clearable
          inputRef={searchRef}
          value={query}
          onValueChange={setQuery}
          placeholder={withShortcut(commandLabel("search"), searchCommand.shortcut!)}
          aria-label={commandLabel("search")}
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown") return;
            // Down from the search box goes into the results, as in Visual Studio.
            e.preventDefault();
            e.currentTarget.closest(".idle-explorer")?.querySelector<HTMLElement>('.sp-tree-row[tabindex="0"]')?.focus();
          }}
          trailing={
            <ToolbarButton icon="list" label={commandLabel("searchContents")} active={searchContents}
              onClick={() => {
                run.searchContents(rootNode());
                // Back to typing.
                searchRef.current?.focus();
              }}
            />
          }
        />
      </div>
      <div className="project-explorer idle-explorer-tree" onFocus={handleFocus} onKeyDown={handleKeyDown} onContextMenu={handleBackgroundContextMenu}>
        {empty ? (
          <div className="idle-explorer-message">{query.trim() ? t('No items match "{query}".', { query: query.trim() }) : t("No items match the filter.")}</div>
        ) : (
          <FileTree
            nodes={shownNodes}
            expandedIds={expandedIds}
            onExpandedChange={onExpandedChange}
            selectedIds={selectedIds}
            onSelectionChange={(ids) => {
              setSelectedIds(ids);
              publishSelection(ids);
            }}
            onActivate={(node) => openFile({ path: node.id, name: node.name })}
            getMenuItems={getMenuItems}
            canDrag={(node) => !isRoot(node) && !node.generated && editing === null}
            onDropNodes={(ids, folder, copyDrop) => void transfer(ids, folder.id, copyDrop)}
            highlights={filtered?.highlights}
            editingId={editing?.kind === "rename" ? editing.id : editing ? placeholderId(editing.folder) : null}
            onRenameCommit={(node, name) => void commitEdit(node, name)}
            onRenameCancel={() => setEditing(null)}
            onExpandAll={(node) =>
              filtered
                ? onExpandedChange(new Set([...expandedIds, ...folderIdsUnder(node)]))
                : void tree.expandSubtree(node.id, { skip: (path) => !!projectItems && !showAllFiles && !projectItems.has(path) })
            }
            reveal={reveal}
          />
        )}
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

/** Every folder (and file with nested ones) at or under `node`. */
function folderIdsUnder(node: FileTreeNode, out: string[] = []): string[] {
  const inner = node.children ?? node.nested;
  if (!inner) return out;
  out.push(node.id);
  for (const child of inner) folderIdsUnder(child, out);
  return out;
}
