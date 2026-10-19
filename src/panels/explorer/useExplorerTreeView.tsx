// The tree as shown: its scope, filters and search, selection, what changed, what's open.

import { type FocusEvent, useEffect, useMemo, useRef, useState } from "react";
import { type ChangeKind, changeKindLabel, changeLetter, fileNameOf, fileTreeFromEntries, type FileTreeNode, filterFileTree, joinPath, nestFiles, t, useContextMenu, useDirectoryTree, useGit, useShell, useStoredState, useT } from "substrate-platform-ui";
import { useActiveFileTab, useOpenFiles } from "../../OpenFilesContext";
import { files } from "../../files";
import { useFsChanged, useWatchedFolders } from "../../fsWatch";
import { registerExplorerRename, selectMultiple, selectPath } from "../../ideSelection";
import { isWithin, renamedPath } from "../../paths";
import { changedFiles, type Editing, explorerClipboard, type ListFilter, type ScopeHistory, useGeneratedCode } from "./explorerModel";
import { reportListError } from "./listError";
import { useContentMatches, useProjectItems } from "./projectItems";
import { explorerMatch, findNode, nestParent, withChangeMarks, withFaded, withGeneratedCode, withPlaceholder, withProjectItems, withResourceIcons } from "./projectTree";
import type { ExplorerTreeProps } from "../ProjectExplorer";

/** The tree as shown: its scope, filters and search, selection, what changed, what's open. */
export function useExplorerTreeView(props: ExplorerTreeProps) {
  const { project, initialScope, main = false } = props;
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
        <span className={`sp-git-letter sp-git-kind-${kind}`} title={t(changeKindLabel(kind as ChangeKind))}>
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

  return { shell, scopes, setScopes, scopeRoot, scoped, tree, tabs, pathRenamed, pathRemoved, activeTab, git, selectedIds, setSelectedIds, newItem, setNewItem, editing, setEditing, query, setQuery, listFilter, setListFilter, showAllFiles, setShowAllFiles, trackActive, setTrackActive, searchContents, setSearchContents, revision, setRevision, setClipboardSeq, reveal, setReveal, pendingReveal, setPendingReveal, backgroundMenu, filterMenu, searchRef, treeRef, entries, projectItems, contentHits, changed, only, filtering, baseNodes, generated, decorated, filtered, filterKey, filterExpanded, setFilterExpanded, expandedIds, onExpandedChange, clip, shownNodes, publishSelection, handleFocus };
}

/** What `useExplorerTreeView` gives the component. */
export type ExplorerTreeView = ReturnType<typeof useExplorerTreeView>;
