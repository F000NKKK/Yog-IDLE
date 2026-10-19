import { useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { message, open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AppearanceSettings,
  appearanceSettingsKeywords,
  closeGitDocument,
  EditorSettings,
  editorSettingsKeywords,
  GIT_CHANGES_PANEL,
  GitChangesWindow,
  GitHost,
  GitMenu,
  gitSettingsKeywords,
  GitSettingsPage,
  GitStatusBar,
  hostFiles,
  InternationalSettings,
  internationalSettingsKeywords,
  isGitDocument,
  MenuBar,
  MenuBarItem,
  notify,
  onOpenGitSettings,
  openFile,
  openLink,
  OutputWindow,
  PlatformShell,
  pt,
  SettingsWindow,
  t,
  TerminalPanel,
  Toolbar,
  type ToolbarSection,
  useGitPanels,
  useKeybinding,
  useLocale,
  useT,
  useWorkflowRunner,
  WindowControls,
} from "substrate-platform-ui";
import type { PanelDef, SettingsSection } from "substrate-platform-ui";

import { EmptyEditorState } from "./panels/EmptyEditorState";
import { Toolbox } from "./panels/Toolbox";
import { DocumentOutline } from "./panels/DocumentOutline";
import { ProjectExplorer, ProjectExplorerView } from "./panels/ProjectExplorer";
import { ExplorerKeybindings, PROJECT_EXPLORER_PANEL, PROJECT_EXPLORER_VIEW_PANEL } from "./panels/explorer/explorerBus";
import { importContent } from "./content/importContent";
import { ActiveDocumentSelection, Properties } from "./panels/Properties";
import { RunToolbar } from "./panels/RunToolbar";
import { PublishWindow } from "./panels/PublishWindow";
import { DebugPanel } from "./panels/DebugPanel";
import { ProjectProvider, useProject, type RecentEntry } from "./ProjectContext";
import { OpenFilesProvider, useOpenFiles } from "./OpenFilesContext";
import { BreakpointsProvider } from "./BreakpointsContext";
import { DebugSessionProvider, useDebugSessionContext } from "./DebugSessionContext";
import { GameStatusBar, useGameStatus, type GameStage } from "./useGameStatus";
import { EVENT, listenAll, listenTo } from "./events";
import { useHotReload } from "./useHotReload";
import { EditMenu, EditorKeybindings, editorToolbarSections, useEditorActions, type EditorActions } from "./EditorActions";
import { OpenFilesPersistence } from "./OpenFilesPersistence";
import {
  CODE_SEARCH_PANEL,
  CodeSearchPanel,
  FIND_IN_FILES_PANEL,
  FIND_RESULTS_PANEL,
  FindInFilesWindow,
  FindResultsPanel,
  SearchHost,
} from "./search/SearchHost";
import { ViewMenu } from "./ViewMenu";
import { WorkspaceProvider } from "./WorkspaceContext";
import { installCloseHandler } from "./windowClose";
import { BuildSettingsPage, BuildSettingsSync, buildSettingsKeywords } from "./tools/BuildSettings";
import { missingTools, openInstaller, toolsStatus } from "./tools/toolsStore";
import { ProjectPropertiesWindow } from "./projectProperties/ProjectPropertiesWindow";
import { onOpenProjectProperties, openProjectProperties, type ProjectPropertiesPage } from "./projectProperties/bus";
import { ErrorListPanel } from "./panels/ErrorListPanel";
import { BuildDiagnosticsSync } from "./diagnostics/buildDiagnostics";
import { OutputSourceSync } from "./outputSource";

import { OpenWithPickerHost } from "./OpenWithPicker";
import { SourceControl } from "./SourceControl";
import "./App.css";
import { invokeYog } from "./invokeYog";
import { runModCommand } from "./runModCommand";

// Everything below is Yog-IDLE-specific: which panels exist, where they
// start docked, and what the menu/settings contain. The shell itself
// (theme, docking, drag-to-redock/float, the generic Terminal/Output
// panels, the Settings window chrome) lives in substrate-platform-ui —
// Yog-IDLE only adds its own content on top.

// Hidden (no visible tab — see `PanelDef.hidden`) placeholder for the
// center dock's permanent slot; every real open file gets its own genuine
// dock tab via `OpenFilesProvider`'s `panels`, with no wrapper tab around
// them.
const mainPanel: PanelDef = { id: "editor-empty", title: "", component: EmptyEditorState, hidden: true };

/**
 * The Output tool window, Visual-Studio-style: "Show output from:" picks
 * which source's buffer it shows (`outputSource`), Clear empties just that
 * one. The buffers live outside the panel (`outputBuffer`), so they keep
 * filling while it's hidden.
 */
/** The tool windows, titled in the active locale — rebuilt when it changes. */
function makeToolWindows() {
  return {
    left: [
      { id: "toolbox", title: t("Toolbox"), component: Toolbox } satisfies PanelDef,
      { id: "documentOutline", title: t("Document Outline"), component: DocumentOutline } satisfies PanelDef,
    ],
    right: [
      { id: PROJECT_EXPLORER_PANEL, title: t("Project Explorer"), component: ProjectExplorer } satisfies PanelDef,
      // Transient, like Visual Studio's New Solution Explorer View: opens floating, dockable anywhere.
      { id: PROJECT_EXPLORER_VIEW_PANEL, title: t("Project Explorer View"), component: ProjectExplorerView, floatSize: { w: 320, h: 480 } } satisfies PanelDef,
      { id: GIT_CHANGES_PANEL, title: t("Git Changes"), component: GitChangesWindow } satisfies PanelDef,
      { id: "properties", title: t("Properties"), component: Properties } satisfies PanelDef,
    ],
    bottom: [
      { id: "errorList", title: t("Error List"), component: ErrorListPanel } satisfies PanelDef,
      { id: "output", title: t("Output"), component: OutputWindow } satisfies PanelDef,
      { id: "terminal", title: t("Terminal"), component: TerminalPanel } satisfies PanelDef,
      { id: "debug", title: t("Debug"), component: DebugPanel } satisfies PanelDef,
      { id: FIND_RESULTS_PANEL, title: t("Find Results"), component: FindResultsPanel } satisfies PanelDef,
      // Transient: open floating, leave no strip tab when closed — dockable anywhere meanwhile.
      { id: FIND_IN_FILES_PANEL, title: t("Find and Replace"), component: FindInFilesWindow, floatSize: { w: 500, h: 380 } } satisfies PanelDef,
      { id: CODE_SEARCH_PANEL, title: t("Code Search"), component: CodeSearchPanel, floatSize: { w: 640, h: 460 } } satisfies PanelDef,
    ],
  };
}

function makeSettingsSections(): SettingsSection[] {
  return [
    { id: "appearance", label: t("Appearance"), content: <AppearanceSettings />, keywords: appearanceSettingsKeywords },
    { id: "editor", label: t("Editor"), content: <EditorSettings />, keywords: editorSettingsKeywords },
    { id: "international", label: t("International Settings"), content: <InternationalSettings />, keywords: internationalSettingsKeywords },
    { id: "build", label: t("Build"), content: <BuildSettingsPage />, keywords: buildSettingsKeywords },
    { id: "sourceControl", label: t("Source Control"), content: <GitSettingsPage />, keywords: gitSettingsKeywords },
  ];
}

/** Basic build operations only, for the generic workflow.toml fallback path — Restore/Build/Clean/Test/Publish. "Run" targets live in the Run toolbar instead. */
function isBasicBuildWorkflow(name: string): boolean {
  return /^(restore|build|clean|test|publish)/i.test(name);
}

/**
 * The "Build" menu — for a `yog-mod` project (the universal case) this is
 * just two fixed actions: Build (`yog build`) and Publish (opens the
 * `PublishWindow` configurator, since publishing has its own profile/mode
 * settings, not a single command to just run). Anything else falls back to
 * whatever workflows a project's own `workflow.toml` happens to define.
 */
function BuildMenu({ onOpenPublish }: { onOpenPublish: () => void }) {
  const t = useT();
  const { project } = useProject();
  if (!project) {
    // Nothing to build yet — the usual actions, shown but unavailable.
    return (
      <MenuBarItem
        label={t("Build")}
        items={[
          { label: pt("command", "Build"), disabled: true },
          { label: t("Clean"), disabled: true },
          { label: t("Publish..."), disabled: true, separatorBefore: true },
          { label: t("Cancel Build"), disabled: true, separatorBefore: true },
        ]}
      />
    );
  }
  if (project.kind === "yog-mod") return <ModBuildMenu root={project.root} onOpenPublish={onOpenPublish} />;
  return <WorkflowBuildMenu root={project.root} />;
}

/** Whether a Build/Publish workflow run is in flight — counted from `workflow-start`/`workflow-exit`, ignoring the payload-less `workflow-exit` a game exiting fires. */
function useWorkflowActive(): boolean {
  const [active, setActive] = useState(0);
  useEffect(() => {
    return listenAll([
      listenTo(EVENT.workflowStart, () => setActive((n) => n + 1)),
      listenTo(EVENT.workflowExit, (exit) => {
        if (exit) setActive((n) => Math.max(0, n - 1));
      }),
    ]);
  }, []);
  return active > 0;
}

/** Build > Cancel Build — stops every Build/Publish still running (`workflow_cancel`). */
function useCancelBuildItem() {
  const active = useWorkflowActive();
  return { label: t("Cancel Build"), onClick: () => invokeYog("run", "workflow_cancel"), disabled: !active, separatorBefore: true };
}

function ModBuildMenu({ root, onOpenPublish }: { root: string; onOpenPublish: () => void }) {
  const t = useT();
  const cancelItem = useCancelBuildItem();
  return (
    <MenuBarItem
      label={t("Build")}
      items={[
        { label: pt("command", "Build"), onClick: () => runModCommand("mod_build", root, t("Build")) },
        // `yog-cli` has no clean command — `mod_clean` removes what builds
        // produce, so not while a build is still writing there.
        { label: t("Clean"), onClick: () => runModCommand("mod_clean", root, t("Clean")), disabled: !cancelItem.disabled },
        { label: t("Publish..."), onClick: onOpenPublish, separatorBefore: true },
        cancelItem,
      ]}
    />
  );
}

function WorkflowBuildMenu({ root }: { root: string }) {
  const t = useT();
  const runner = useWorkflowRunner(root);
  const cancelItem = useCancelBuildItem();
  const items = runner.workflows.filter((w) => isBasicBuildWorkflow(w.name)).map((w) => ({ label: w.name, onClick: () => runner.run(w.name) }));
  return <MenuBarItem label={t("Build")} items={[...items, cancelItem]} />;
}

/** Recent entries as submenu items, labelled by name only; same-named entries get their parent folder's name appended so they stay tellable apart. */
function recentItems(entries: RecentEntry[], open: (root: string) => void) {
  return entries.map((entry) => {
    const clash = entries.some((other) => other !== entry && other.name === entry.name);
    const parent = entry.root.split(/[/\\]/).filter(Boolean).slice(-2, -1)[0];
    return { label: clash && parent ? `${entry.name} (${parent})` : entry.name, onClick: () => open(entry.root) };
  });
}

/** File > Open Project/Open Folder (each a submenu: Browse… plus its own recent list) and Open File, backed by the native OS picker (`@tauri-apps/plugin-dialog`). Projects and folders replace the current project via `ProjectContext`; Open File just opens a single file as an editor tab, expanding the allowed-path boundary to cover it (see `allow_path` on the Rust side) since it needn't belong to any open project. */
function FileMenu({ editor }: { editor: EditorActions }) {
  const t = useT();
  const { project, openPath, recent, clearRecent, closeProject } = useProject();
  const { tabs, closeTab, closeAll, saveAs, confirmUnsaved, discardAll } = useOpenFiles();
  const tab = editor.tab;

  async function saveTabAs() {
    if (!tab) return;
    const chosen = await saveDialog({ defaultPath: tab.path });
    if (typeof chosen === "string") await saveAs(tab.id, chosen);
  }

  async function closeFolder() {
    // Asked here, while the project's tabs are still what its workspace
    // remembers; closing the project saves that before the tabs go.
    if (!(await confirmUnsaved())) return;
    closeProject();
    // After the switch has written the outgoing workspace (an effect of it).
    setTimeout(discardAll, 0);
  }

  async function openFolder() {
    const chosen = await open({ directory: true });
    if (typeof chosen === "string") await openPath(chosen, "folder");
  }

  async function openProject() {
    // Yog-IDLE has no "solution" file format — a project *is* a `yog.toml`.
    // The native dialog can only filter by extension, not filename, so this
    // guides the user toward picking one; we then use its parent folder as
    // the project root.
    const chosen = await open({ filters: [{ name: t("Yog Project (yog.toml)"), extensions: ["toml"] }] });
    if (typeof chosen !== "string") return;
    const dir = chosen.slice(0, Math.max(chosen.lastIndexOf("/"), chosen.lastIndexOf("\\")));
    await openPath(dir, "project");
  }

  async function browseForFile() {
    const chosen = await open({ multiple: false });
    if (typeof chosen !== "string") return;
    const dir = chosen.slice(0, Math.max(chosen.lastIndexOf("/"), chosen.lastIndexOf("\\")));
    await hostFiles.allow(dir).catch(() => {});
    openFile({ path: chosen, name: chosen.split(/[/\\]/).pop() ?? chosen });
  }

  return (
    <MenuBarItem
      label={t("File")}
      items={[
        {
          label: t("Open Project"),
          items: [
            { label: t("Browse..."), onClick: openProject },
            ...recentItems(recent.project, (root) => openPath(root, "project")).map((item, i) => ({ ...item, separatorBefore: i === 0 })),
            { label: t("Clear Recent Projects"), onClick: () => clearRecent("project"), disabled: recent.project.length === 0, separatorBefore: true },
          ],
        },
        {
          label: t("Open Folder"),
          items: [
            { label: t("Browse..."), onClick: openFolder },
            ...recentItems(recent.folder, (root) => openPath(root, "folder")).map((item, i) => ({ ...item, separatorBefore: i === 0 })),
            { label: t("Clear Recent Folders"), onClick: () => clearRecent("folder"), disabled: recent.folder.length === 0, separatorBefore: true },
          ],
        },
        { label: t("Open File..."), onClick: browseForFile },
        { label: t("Close"), shortcut: "Ctrl+F4", disabled: !tab, onClick: () => tab && void closeTab(tab.id), separatorBefore: true },
        { label: t("Close All"), disabled: tabs.length === 0, onClick: () => void closeAll() },
        { label: t("Close Folder"), disabled: !project, onClick: () => void closeFolder() },
        { label: t("Save"), shortcut: "Ctrl+S", disabled: !editor.canSave, onClick: () => void editor.save(), separatorBefore: true },
        { label: t("Save As..."), disabled: !tab, onClick: () => void saveTabAs() },
        { label: t("Save All"), shortcut: "Ctrl+Shift+S", disabled: !editor.hasDirty, onClick: () => void editor.saveAll() },
        // Through the window's close request, so unsaved tabs are asked about first.
        { label: t("Exit"), shortcut: "Alt+F4", onClick: () => void getCurrentWindow().close(), separatorBefore: true },
      ]}
    />
  );
}

/** Project > Properties (Alt+Enter on the project in Project Explorer) and the manifest itself. */
function ProjectMenu() {
  const t = useT();
  const { project } = useProject();
  const mod = project?.kind === "yog-mod" ? project : null;
  return (
    <MenuBarItem
      label={t("Project")}
      items={[
        {
          label: mod ? t("{name} Properties...", { name: mod.name }) : t("Properties..."),
          shortcut: "Alt+Enter",
          disabled: !mod,
          onClick: () => openProjectProperties(),
        },
        { label: t("Dependencies..."), disabled: !mod, onClick: () => openProjectProperties("dependencies") },
        { label: t("Run Targets..."), disabled: !mod, onClick: () => openProjectProperties("debug") },
        { label: t("Import..."), disabled: !mod, separatorBefore: true, onClick: () => mod && void importContent(mod.root) },
        {
          label: t("Edit Project File"),
          disabled: !mod,
          separatorBefore: true,
          onClick: () => mod && openFile({ path: `${mod.root.replace(/[/\\]+$/, "")}/yog.toml`, name: "yog.toml" }),
        },
      ]}
    />
  );
}

/** Tools > Check Components — whether what Yog needs is installed; what isn't opens Yog Installer. */
async function checkComponents() {
  const missing = missingTools(await toolsStatus());
  if (missing.length > 0) await openInstaller();
  else notify({ level: "info", message: t("Everything Yog needs to build and run mods is installed.") });
}

/** Debug > Continue/Step/Restart/Stop — the same actions as the Debug panel and the toolbar, enabled under the same conditions. Starting a run stays with the Run toolbar, which owns the target/mode selection. */
function DebugMenu() {
  const t = useT();
  const { debugging, stopped, canRestart, continue_, step, pause, restart, stop } = useDebugSessionContext();
  const paused = debugging && !!stopped && stopped.reason !== "exited";
  return (
    <MenuBarItem
      label={t("Debug")}
      items={[
        { label: t("Continue"), onClick: continue_, disabled: !paused, shortcut: "F5" },
        { label: t("Break All"), onClick: pause, disabled: !debugging || !!stopped, shortcut: "Ctrl+Alt+Break" },
        { label: t("Step Over"), onClick: () => step("over"), disabled: !paused, shortcut: "F10", separatorBefore: true },
        { label: t("Step Into"), onClick: () => step("into"), disabled: !paused, shortcut: "F11" },
        { label: t("Step Out"), onClick: () => step("out"), disabled: !paused, shortcut: "Shift+F11" },
        { label: t("Restart"), onClick: restart, disabled: !debugging || !canRestart, shortcut: "Ctrl+Shift+F5", separatorBefore: true },
        { label: t("Stop Debugging"), onClick: stop, disabled: !debugging, shortcut: "Shift+F5" },
      ]}
    />
  );
}

const REPO_URL = "https://github.com/F000NKKK/Yog-IDLE";
const YOG_URL = "https://github.com/F000NKKK/Yog-Mod-Loader";

function HelpMenu() {
  const t = useT();
  async function about() {
    const version = await getVersion().catch(() => t("unknown"));
    await message(`Yog IDLE ${version}\n\n${t("An IDE for Yog Minecraft mods, built on Substrate Platform.")}\n\n${REPO_URL}`, { title: t("About Yog IDLE") });
  }
  return (
    <MenuBarItem
      label={t("Help")}
      items={[
        { label: t("About Yog IDLE"), onClick: about },
        { label: t("Yog IDLE on GitHub"), onClick: () => void openLink(REPO_URL) },
        { label: t("Yog Mod Loader on GitHub"), onClick: () => void openLink(YOG_URL) },
      ]}
    />
  );
}

interface MenuProps {
  onOpenSettings: () => void;
  onOpenPublish: () => void;
  editor: EditorActions;
}

function Menu({ onOpenSettings, onOpenPublish, editor }: MenuProps) {
  const t = useT();
  return (
    <MenuBar title="Yog IDLE" windowControls={<WindowControls />}>
      <FileMenu editor={editor} />
      <EditMenu actions={editor} />
      <ViewMenu />
      <GitMenu />
      <ProjectMenu />
      <BuildMenu onOpenPublish={onOpenPublish} />
      <DebugMenu />
      <MenuBarItem
        label={t("Tools")}
        items={[
          { label: t("Check Components..."), onClick: () => void checkComponents() },
          { label: t("Yog Installer..."), onClick: () => void openInstaller() },
          { label: t("Options..."), onClick: onOpenSettings, separatorBefore: true },
        ]}
      />
      <HelpMenu />
    </MenuBar>
  );
}

/** What the toolbar's run-time section (Hot Reload/Restart/Stop) needs to know and do. */
interface RunActions {
  /** Something launched from the Run toolbar is still going (a game, or a workflow run). */
  running: boolean;
  /** Where the launched game is — `"ready"` once it has reported in over the control socket. */
  gameStage: GameStage;
  debugging: boolean;
  canRestart: boolean;
  /** `null` when the open project can't be hot-reloaded at all (not a `yog-mod` project). */
  onHotReload: (() => void) | null;
  hotReloading: boolean;
  onRestart: () => void;
  onStop: () => void;
}

/**
 * The toolbar's run-time section — Hot Reload/Restart/Stop only appear once
 * something is actually running: Stop/Restart work for any launch — a game,
 * Release or Debug, or a `workflow.toml` target (see `Shell` for which
 * backend call each uses); Hot Reload needs
 * the game to have connected its control socket (`gameStage === "ready"`) —
 * it rebuilds and swaps the new build in over that socket
 * (`mod_hot_reload`). The editing sections before it come from
 * `editorToolbarSections`.
 */
function runToolbarSections(run: RunActions): ToolbarSection[] {
  const sections: ToolbarSection[] = [];
  const gameUp = run.gameStage !== "idle" || run.debugging;
  if (run.running || gameUp) {
    const hotReload = run.onHotReload;
    sections.push([
      {
        icon: "hotReload",
        label: run.hotReloading ? t("Hot Reloading…") : t("Hot Reload"),
        disabled: !hotReload || run.gameStage !== "ready" || run.hotReloading,
        onClick: hotReload ?? undefined,
      },
      { icon: "restart", label: t("Restart"), disabled: !run.canRestart, onClick: run.onRestart },
      { icon: "stop", label: run.debugging ? t("Stop Debugging") : t("Stop"), onClick: run.onStop },
    ]);
  }
  return sections;
}

/** The menu bar, toolbar and editor keybindings — rendered inside the shell, since they act on its active editor tab and tool windows. */
function ShellChrome({ onOpenSettings, onOpenPublish, run, onRunningChange }: Omit<MenuProps, "editor"> & { run: RunActions; onRunningChange: (running: boolean) => void }) {
  const editor = useEditorActions();
  // The toolbar's labels are built by plain functions — re-rendered here when the locale changes.
  useLocale();
  return (
    <>
      <Menu onOpenSettings={onOpenSettings} onOpenPublish={onOpenPublish} editor={editor} />
      <Toolbar leading={<RunToolbar onRunningChange={onRunningChange} />} sections={[...editorToolbarSections(editor), ...runToolbarSections(run)]} />
      <EditorKeybindings actions={editor} />
      <ExplorerKeybindings />
      <SearchHost />
      <GitHost />
      <OpenWithPickerHost />
      <OpenFilesPersistence />
      <ActiveDocumentSelection />
    </>
  );
}

function Shell({ onOpenSettings, onOpenPublish }: { onOpenSettings: () => void; onOpenPublish: () => void }) {
  const { panels, closeTab } = useOpenFiles();
  const gitPanels = useGitPanels();
  const centerPanels = useMemo(() => [...panels, ...gitPanels], [panels, gitPanels]);
  const { debugging, canRestart, restart, restartWorkflow, stop } = useDebugSessionContext();
  const { project } = useProject();
  const gameStatus = useGameStatus();
  const hotReload = useHotReload(restart);
  const [running, setRunning] = useState(false);
  const locale = useLocale();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const toolWindows = useMemo(makeToolWindows, [locale]);
  const modRoot = project?.kind === "yog-mod" ? project.root : null;
  const gameUp = gameStatus.stage !== "idle" || debugging;
  const runActions: RunActions = {
    running,
    gameStage: gameStatus.stage,
    debugging,
    canRestart,
    onHotReload: modRoot ? () => hotReload.trigger(modRoot) : null,
    hotReloading: hotReload.busy,
    // A game (Release or Debug) is stopped through `debug_stop`; anything
    // else still running — a `workflow.toml` target, a mod run that hasn't
    // launched its game yet — is a workflow run, cancelled as such.
    onRestart: gameUp ? restart : () => void restartWorkflow(),
    onStop: gameUp ? stop : () => void invokeYog("run", "workflow_cancel"),
  };
  return (
    <PlatformShell
      main={mainPanel}
      toolWindows={toolWindows}
      persistKey="yog-idle"
      extraCenterPanels={centerPanels}
      onCloseDynamicPanel={(id) => (isGitDocument(id) ? closeGitDocument(id) : void closeTab(id))}
      menu={<ShellChrome onOpenSettings={onOpenSettings} onOpenPublish={onOpenPublish} run={runActions} onRunningChange={setRunning} />}
      statusBar={<GameStatusBar text={gameStatus.text} busy={gameStatus.busy} trailing={<GitStatusBar />} />}
    />
  );
}

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined);
  const [publishOpen, setPublishOpen] = useState(false);
  /** The page Project Properties is open on — `null` while closed. */
  const [propertiesPage, setPropertiesPage] = useState<{ page?: ProjectPropertiesPage; key: number } | null>(null);
  const { project } = useProject();
  const locale = useLocale();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const settingsSections = useMemo(() => makeSettingsSections(), [locale]);
  const mod = project?.kind === "yog-mod" ? project : null;

  // Git > Settings.
  useEffect(
    () =>
      onOpenGitSettings(() => {
        setSettingsSection("sourceControl");
        setSettingsOpen(true);
      }),
    [],
  );
  useEffect(() => onOpenProjectProperties((page) => setPropertiesPage((prev) => ({ page, key: (prev?.key ?? 0) + 1 }))), []);
  // Another project's properties never stay open.
  useEffect(() => setPropertiesPage(null), [project?.root]);

  // Visual Studio: Alt+Enter on the project in Solution Explorer.
  useKeybinding("Alt+Enter", () => openProjectProperties(), {
    id: "project.properties",
    enabled: !!mod,
    when: () => !!document.activeElement?.closest(".project-explorer"),
  });

  // Closing the window first asks about unsaved files, then writes the
  // remembered UI state (see `windowClose`).
  useEffect(() => installCloseHandler(), []);

  return (
    <main className="app-root">
      <OutputSourceSync />
      <BuildDiagnosticsSync root={project?.root ?? null} project={project?.name} />
      <BuildSettingsSync />
      <Shell
        onOpenSettings={() => {
          setSettingsSection(undefined);
          setSettingsOpen(true);
        }}
        onOpenPublish={() => setPublishOpen(true)}
      />
      {settingsOpen && <SettingsWindow key={settingsSection} sections={settingsSections} initialSectionId={settingsSection} onClose={() => setSettingsOpen(false)} />}
      {propertiesPage && mod && (
        <ProjectPropertiesWindow
          key={propertiesPage.key}
          root={mod.root}
          name={mod.name}
          initialPage={propertiesPage.page}
          onClose={() => setPropertiesPage(null)}
          onOpenPublish={() => setPublishOpen(true)}
        />
      )}
      {publishOpen && project && <PublishWindow projectRoot={project.root} onClose={() => setPublishOpen(false)} />}
    </main>
  );
}

function AppWithProviders() {
  return (
    <ProjectProvider>
      <WorkspaceProvider>
        <OpenFilesProvider>
          <SourceControl>
            <BreakpointsProvider>
              <DebugSessionProvider>
                <App />
              </DebugSessionProvider>
            </BreakpointsProvider>
          </SourceControl>
        </OpenFilesProvider>
      </WorkspaceProvider>
    </ProjectProvider>
  );
}

export default AppWithProviders;
