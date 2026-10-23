import {
  ContextMenu,
  FileTree,
  openFile,
  SearchField,
  t,
  Toolbar,
  ToolbarButton,
  ToolbarGroup,
  useT,
  withShortcut,
} from "substrate-platform-ui";
import { useProject, type ProjectInfo } from "../project/ProjectContext";
import { isWithin } from "../project/paths";
import { NewItemDialog } from "./NewItemDialog";
import { commandLabel } from "./explorer/commands";
import { useExplorerView } from "./explorer/explorerBus";
import {
  placeholderId,
} from "./explorer/projectTree";
import "./explorer/explorer.css";
import { folderIdsUnder } from "./explorer/explorerModel";
import { useExplorerTreeView } from "./explorer/useExplorerTreeView";
import { useExplorerOperations } from "./explorer/useExplorerOperations";
import { useExplorerCommands } from "./explorer/useExplorerCommands";

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
/** A Project Explorer tree: the project, the folder it opens scoped to, and whether it's the main view. */
export interface ExplorerTreeProps {
  project: ProjectInfo;
  initialScope?: string;
  main?: boolean;
}

function ProjectExplorerTree(props: ExplorerTreeProps) {
  const explorerTreeView = useExplorerTreeView(props);
  const explorerOperations = useExplorerOperations(props, explorerTreeView);
  const explorerCommands = useExplorerCommands(props, explorerTreeView, explorerOperations);
  const { scopes, scopeRoot, scoped, tree, selectedIds, setSelectedIds, newItem, setNewItem, editing, setEditing, query, setQuery, listFilter, showAllFiles, trackActive, searchContents, reveal, backgroundMenu, filterMenu, searchRef, projectItems, filtered, expandedIds, onExpandedChange, shownNodes, publishSelection, handleFocus } = explorerTreeView;
  const { rootNode, isRoot, addFromTemplate, addPlain, transfer, commitEdit, activePath } = explorerOperations;
  const { run, getMenuItems, handleKeyDown, handleBackgroundContextMenu, backgroundItems, button, filterItems, searchCommand, empty } = explorerCommands;

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

