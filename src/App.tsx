import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { message, open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  PlatformShell,
  MenuBar,
  MenuBarItem,
  TerminalPanel,
  OutputPanel,
  clearOutputBuffer,
  ContextMenu,
  useContextMenu,
  Icon,
  IconButton,
  SettingsWindow,
  AppearanceSettings,
  appearanceSettingsKeywords,
  EditorSettings,
  editorSettingsKeywords,
  InternationalSettings,
  internationalSettingsKeywords,
  WindowControls,
  Toolbar,
  StatusBar,
  useWorkflowRunner,
  pt,
  t,
  useLocale,
  useT,
  type ToolbarSection,
} from "substrate-platform-ui";
import type { PanelDef, SettingsSection } from "substrate-platform-ui";

import { EmptyEditorState } from "./panels/EmptyEditorState";
import { Toolbox } from "./panels/Toolbox";
import { ProjectExplorer } from "./panels/ProjectExplorer";
import { ActiveDocumentSelection, Properties } from "./panels/Properties";
import { RunToolbar } from "./panels/RunToolbar";
import { PublishWindow } from "./panels/PublishWindow";
import { DebugPanel } from "./panels/DebugPanel";
import { ProjectProvider, useProject, type RecentEntry } from "./ProjectContext";
import { OpenFilesProvider, useOpenFiles } from "./OpenFilesContext";
import { BreakpointsProvider } from "./BreakpointsContext";
import { DebugSessionProvider, useDebugSessionContext } from "./DebugSessionContext";
import { useGameStatus, type GameStage, type WorkflowExitEvent } from "./useGameStatus";
import { useHotReload } from "./useHotReload";
import { EditMenu, EditorKeybindings, editorToolbarSections, useEditorActions, type EditorActions } from "./EditorActions";
import { OpenFilesPersistence } from "./OpenFilesPersistence";
import { FIND_RESULTS_PANEL, FindResultsPanel, SearchHost } from "./search/SearchHost";
import { ViewMenu } from "./ViewMenu";
import { WorkspaceProvider } from "./WorkspaceContext";
import { installCloseHandler } from "./windowClose";
import { reportError } from "./reportError";
import { requestOpenFile } from "./fileOpenBus";
import { OUTPUT_SOURCES, OutputSourceSync, setOutputSource, useOutputSource, type OutputSource } from "./outputSource";

import "./App.css";

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
function OutputToolWindow() {
  const t = useT();
  const source = useOutputSource();
  const menu = useContextMenu<void>();
  const current = OUTPUT_SOURCES.find((s) => s.id === source) ?? OUTPUT_SOURCES[0];
  return (
    <div className="output-panel">
      <div className="output-panel-toolbar">
        <span className="output-panel-label">{t("Show output from:")}</span>
        <div className="output-panel-source-anchor">
          <button type="button" className="output-panel-source" onClick={() => menu.openAtAnchor()}>
            <span>{t(current.label)}</span>
            <Icon name="chevronRight" size={11} className="output-panel-chevron" />
          </button>
          <ContextMenu
            target={menu.target ? { mode: "anchor" } : null}
            items={OUTPUT_SOURCES.map((s) => ({
              label: t(s.label),
              checked: s.id === source,
              onSelect: () => setOutputSource(s.id),
            }))}
            onClose={menu.close}
          />
        </div>
        <span className="output-panel-spacer" />
        <IconButton size={22} title={t("Clear {source} Output", { source: t(current.label) })} onClick={() => clearOutputBuffer(current.event)}>
          <Icon name="trash" size={14} />
        </IconButton>
      </div>
      <div className="output-panel-body">
        <OutputPanel key={current.event} eventName={current.event} emptyLabel={t(EMPTY_LABELS[current.id])} />
      </div>
    </div>
  );
}

const EMPTY_LABELS: Record<OutputSource, string> = {
  build: "Run a Build command to see output here.",
  game: "Start the game to see its output here.",
  debug: "Debugger messages appear here.",
  ide: "No messages.",
};

/** The tool windows, titled in the active locale — rebuilt when it changes. */
function makeToolWindows() {
  return {
    left: [{ id: "toolbox", title: t("Toolbox"), component: Toolbox } satisfies PanelDef],
    right: [
      { id: "projectExplorer", title: t("Project Explorer"), component: ProjectExplorer } satisfies PanelDef,
      { id: "properties", title: t("Properties"), component: Properties } satisfies PanelDef,
    ],
    bottom: [
      { id: "output", title: t("Output"), component: OutputToolWindow } satisfies PanelDef,
      { id: "terminal", title: t("Terminal"), component: TerminalPanel } satisfies PanelDef,
      { id: "debug", title: t("Debug"), component: DebugPanel } satisfies PanelDef,
      { id: FIND_RESULTS_PANEL, title: t("Find Results"), component: FindResultsPanel } satisfies PanelDef,
    ],
  };
}

function makeSettingsSections(): SettingsSection[] {
  return [
    { id: "appearance", label: t("Appearance"), content: <AppearanceSettings />, keywords: appearanceSettingsKeywords },
    { id: "editor", label: t("Editor"), content: <EditorSettings />, keywords: editorSettingsKeywords },
    { id: "international", label: t("International Settings"), content: <InternationalSettings />, keywords: internationalSettingsKeywords },
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
    const unlistens = [
      listen("workflow-start", () => setActive((n) => n + 1)),
      listen<WorkflowExitEvent | null>("workflow-exit", (e) => {
        if (e.payload) setActive((n) => Math.max(0, n - 1));
      }),
    ];
    return () => {
      unlistens.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []);
  return active > 0;
}

/** Build > Cancel Build — stops every Build/Publish still running (`workflow_cancel`). */
function useCancelBuildItem() {
  const active = useWorkflowActive();
  return { label: t("Cancel Build"), onClick: () => invoke("workflow_cancel"), disabled: !active, separatorBefore: true };
}

/** Runs a `mod_*` build command — one that's refused outright (e.g. the project isn't open anymore) never starts a workflow, so say why here. */
function runModCommand(command: string, root: string, what: string) {
  invoke(command, { projectRoot: root }).catch((err) => reportError(t("{action} failed to start: {error}", { action: what, error: String(err) })));
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

  async function openFile() {
    const chosen = await open({ multiple: false });
    if (typeof chosen !== "string") return;
    const dir = chosen.slice(0, Math.max(chosen.lastIndexOf("/"), chosen.lastIndexOf("\\")));
    await invoke("allow_path", { path: dir }).catch(() => {});
    requestOpenFile({ path: chosen, name: chosen.split(/[/\\]/).pop() ?? chosen });
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
        { label: t("Open File..."), onClick: openFile },
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
        { label: t("Yog IDLE on GitHub"), onClick: () => openUrl(REPO_URL) },
        { label: t("Yog Mod Loader on GitHub"), onClick: () => openUrl(YOG_URL) },
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
      <BuildMenu onOpenPublish={onOpenPublish} />
      <DebugMenu />
      <MenuBarItem label={t("Tools")} items={[{ label: t("Options..."), onClick: onOpenSettings }]} />
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
      <SearchHost />
      <OpenFilesPersistence />
      <ActiveDocumentSelection />
    </>
  );
}

function Shell({ onOpenSettings, onOpenPublish }: { onOpenSettings: () => void; onOpenPublish: () => void }) {
  const { panels, closeTab } = useOpenFiles();
  const { debugging, canRestart, restart, restartWorkflow, stop } = useDebugSessionContext();
  const { project } = useProject();
  const gameStatus = useGameStatus();
  const hotReload = useHotReload();
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
    onStop: gameUp ? stop : () => void invoke("workflow_cancel"),
  };
  return (
    <PlatformShell
      main={mainPanel}
      toolWindows={toolWindows}
      persistKey="yog-idle"
      extraCenterPanels={panels}
      onCloseDynamicPanel={(id) => void closeTab(id)}
      menu={<ShellChrome onOpenSettings={onOpenSettings} onOpenPublish={onOpenPublish} run={runActions} onRunningChange={setRunning} />}
      statusBar={<StatusBar text={gameStatus.text} busy={gameStatus.busy} detail={gameStatus.lines} />}
    />
  );
}

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const { project } = useProject();
  const locale = useLocale();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const settingsSections = useMemo(makeSettingsSections, [locale]);

  // Closing the window first asks about unsaved files, then writes the
  // remembered UI state (see `windowClose`).
  useEffect(() => installCloseHandler(), []);

  return (
    <main className="app-root">
      <OutputSourceSync />
      <Shell onOpenSettings={() => setSettingsOpen(true)} onOpenPublish={() => setPublishOpen(true)} />
      {settingsOpen && <SettingsWindow sections={settingsSections} onClose={() => setSettingsOpen(false)} />}
      {publishOpen && project && <PublishWindow projectRoot={project.root} onClose={() => setPublishOpen(false)} />}
    </main>
  );
}

function AppWithProviders() {
  return (
    <ProjectProvider>
      <WorkspaceProvider>
        <OpenFilesProvider>
          <BreakpointsProvider>
            <DebugSessionProvider>
              <App />
            </DebugSessionProvider>
          </BreakpointsProvider>
        </OpenFilesProvider>
      </WorkspaceProvider>
    </ProjectProvider>
  );
}

export default AppWithProviders;
