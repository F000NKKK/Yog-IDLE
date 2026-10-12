import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { message, open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  PlatformShell,
  MenuBar,
  MenuBarItem,
  TerminalPanel,
  OutputPanel,
  clearOutputBuffer,
  Icon,
  IconButton,
  SettingsWindow,
  AppearanceSettings,
  WindowControls,
  Toolbar,
  StatusBar,
  useWorkflowRunner,
  type ToolbarSection,
} from "substrate-platform-ui";
import type { PanelDef, SettingsSection } from "substrate-platform-ui";

import { EmptyEditorState } from "./panels/EmptyEditorState";
import { Toolbox } from "./panels/Toolbox";
import { ProjectExplorer } from "./panels/ProjectExplorer";
import { Properties } from "./panels/Properties";
import { RunToolbar } from "./panels/RunToolbar";
import { PublishWindow } from "./panels/PublishWindow";
import { DebugPanel } from "./panels/DebugPanel";
import { ProjectProvider, useProject, type RecentEntry } from "./ProjectContext";
import { OpenFilesProvider, useOpenFiles } from "./OpenFilesContext";
import { BreakpointsProvider } from "./BreakpointsContext";
import { DebugSessionProvider, useDebugSessionContext } from "./DebugSessionContext";
import { useGameStatus, type GameStage, type WorkflowExitEvent } from "./useGameStatus";
import { useHotReload } from "./useHotReload";
import { requestOpenFile } from "./fileOpenBus";

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

const OUTPUT_EVENT = "workflow-output";

/** Output panel wired to the workflow engine's live-output event — every `workflow_run` line lands here, the same way PTY output streams into the Terminal panel. Its toolbar's Clear empties the shared buffer (`clearOutputBuffer`), which outlives the panel itself. */
function BuildOutputPanel() {
  return (
    <div className="output-panel">
      <div className="output-panel-toolbar">
        <IconButton size={22} title="Clear Output" onClick={() => clearOutputBuffer(OUTPUT_EVENT)}>
          <Icon name="trash" size={14} />
        </IconButton>
      </div>
      <div className="output-panel-body">
        <OutputPanel eventName={OUTPUT_EVENT} emptyLabel="Run a Build command to see output here." />
      </div>
    </div>
  );
}

const toolWindows = {
  left: [{ id: "toolbox", title: "Toolbox", component: Toolbox } satisfies PanelDef],
  right: [
    { id: "projectExplorer", title: "Project Explorer", component: ProjectExplorer } satisfies PanelDef,
    { id: "properties", title: "Properties", component: Properties } satisfies PanelDef,
  ],
  bottom: [
    { id: "output", title: "Output", component: BuildOutputPanel } satisfies PanelDef,
    { id: "terminal", title: "Terminal", component: TerminalPanel } satisfies PanelDef,
    { id: "debug", title: "Debug", component: DebugPanel } satisfies PanelDef,
  ],
};

const SETTINGS_SECTIONS: SettingsSection[] = [{ id: "appearance", label: "Appearance", content: <AppearanceSettings /> }];

/** Basic build operations only, for the generic workflow.toml fallback path — Restore/Build/Test/Publish. "Run" targets live in the Run toolbar instead, and Clean isn't surfaced here. */
function isBasicBuildWorkflow(name: string): boolean {
  return /^(restore|build|test|publish)/i.test(name);
}

/**
 * The "Build" menu — for a `yog-mod` project (the universal case) this is
 * just two fixed actions: Build (`yog build`) and Publish (opens the
 * `PublishWindow` configurator, since publishing has its own profile/mode
 * settings, not a single command to just run). Anything else falls back to
 * whatever workflows a project's own `workflow.toml` happens to define.
 */
function BuildMenu({ onOpenPublish }: { onOpenPublish: () => void }) {
  const { project } = useProject();
  if (!project) return <MenuBarItem label="Build" />;
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
  return { label: "Cancel Build", onClick: () => invoke("workflow_cancel"), disabled: !active };
}

function ModBuildMenu({ root, onOpenPublish }: { root: string; onOpenPublish: () => void }) {
  const cancelItem = useCancelBuildItem();
  return (
    <MenuBarItem
      label="Build"
      items={[
        { label: "Build", onClick: () => invoke("mod_build", { projectRoot: root }) },
        { label: "Publish...", onClick: onOpenPublish },
        cancelItem,
      ]}
    />
  );
}

function WorkflowBuildMenu({ root }: { root: string }) {
  const runner = useWorkflowRunner(root);
  const cancelItem = useCancelBuildItem();
  const items = runner.workflows.filter((w) => isBasicBuildWorkflow(w.name)).map((w) => ({ label: w.name, onClick: () => runner.run(w.name) }));
  return <MenuBarItem label="Build" items={[...items, cancelItem]} />;
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
function FileMenu() {
  const { openPath, recent, clearRecent } = useProject();

  async function openFolder() {
    const chosen = await open({ directory: true });
    if (typeof chosen === "string") await openPath(chosen, "folder");
  }

  async function openProject() {
    // Yog-IDLE has no "solution" file format — a project *is* a `yog.toml`.
    // The native dialog can only filter by extension, not filename, so this
    // guides the user toward picking one; we then use its parent folder as
    // the project root.
    const chosen = await open({ filters: [{ name: "Yog Project (yog.toml)", extensions: ["toml"] }] });
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
      label="File"
      items={[
        {
          label: "Open Project",
          items: [
            { label: "Browse...", onClick: openProject },
            ...recentItems(recent.project, (root) => openPath(root, "project")).map((item, i) => ({ ...item, separatorBefore: i === 0 })),
            { label: "Clear Recent Projects", onClick: () => clearRecent("project"), disabled: recent.project.length === 0, separatorBefore: true },
          ],
        },
        {
          label: "Open Folder",
          items: [
            { label: "Browse...", onClick: openFolder },
            ...recentItems(recent.folder, (root) => openPath(root, "folder")).map((item, i) => ({ ...item, separatorBefore: i === 0 })),
            { label: "Clear Recent Folders", onClick: () => clearRecent("folder"), disabled: recent.folder.length === 0, separatorBefore: true },
          ],
        },
        { label: "Open File...", onClick: openFile },
      ]}
    />
  );
}

/** Debug > Continue/Step/Restart/Stop — the same actions as the Debug panel and the toolbar, enabled under the same conditions. Starting a run stays with the Run toolbar, which owns the target/mode selection. */
function DebugMenu() {
  const { debugging, stopped, canRestart, continue_, step, pause, restart, stop } = useDebugSessionContext();
  const paused = debugging && !!stopped && stopped.reason !== "exited";
  return (
    <MenuBarItem
      label="Debug"
      items={[
        { label: "Continue", onClick: continue_, disabled: !paused, shortcut: "F5" },
        { label: "Break All", onClick: pause, disabled: !debugging || !!stopped, shortcut: "Ctrl+Alt+Break" },
        { label: "Step Over", onClick: () => step("over"), disabled: !paused, shortcut: "F10", separatorBefore: true },
        { label: "Step Into", onClick: () => step("into"), disabled: !paused, shortcut: "F11" },
        { label: "Step Out", onClick: () => step("out"), disabled: !paused, shortcut: "Shift+F11" },
        { label: "Restart", onClick: restart, disabled: !debugging || !canRestart, shortcut: "Ctrl+Shift+F5", separatorBefore: true },
        { label: "Stop Debugging", onClick: stop, disabled: !debugging, shortcut: "Shift+F5" },
      ]}
    />
  );
}

const REPO_URL = "https://github.com/F000NKKK/Yog-IDLE";
const YOG_URL = "https://github.com/F000NKKK/Yog-Mod-Loader";

function HelpMenu() {
  async function about() {
    const version = await getVersion().catch(() => "unknown");
    await message(`Yog IDLE ${version}\n\nAn IDE for Yog Minecraft mods, built on Substrate Platform.\n\n${REPO_URL}`, { title: "About Yog IDLE" });
  }
  return (
    <MenuBarItem
      label="Help"
      items={[
        { label: "About Yog IDLE", onClick: about },
        { label: "Yog IDLE on GitHub", onClick: () => openUrl(REPO_URL) },
        { label: "Yog Mod Loader on GitHub", onClick: () => openUrl(YOG_URL) },
      ]}
    />
  );
}

// No Edit or View menu: Undo/Redo/Format/Toggle Comment need a handle on
// "the focused editor" that doesn't exist yet (see `editorToolbarSections`),
// and `PlatformShell` exposes no API for showing/hiding tool windows.
function Menu({ onOpenSettings, onOpenPublish }: { onOpenSettings: () => void; onOpenPublish: () => void }) {
  return (
    <MenuBar title="Yog IDLE" windowControls={<WindowControls />}>
      <FileMenu />
      <BuildMenu onOpenPublish={onOpenPublish} />
      <DebugMenu />
      <MenuBarItem label="Tools" items={[{ label: "Options...", onClick: onOpenSettings }]} />
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
 * The editor action toolbar — Save is real (saves every dirty open file);
 * Undo/Redo/Format/Toggle Comment are disabled placeholders for now (wiring
 * them needs a way to reach "whichever editor is currently focused", which
 * doesn't exist yet). Hot Reload/Restart/Stop only appear once something is
 * actually running: Stop/Restart work for any game launch, Release or Debug
 * (`debug_stop` kills a plain run too); Hot Reload needs the game to have
 * connected its control socket (`gameStage === "ready"`) — it rebuilds and
 * swaps the new build in over that socket (`mod_hot_reload`).
 */
function editorToolbarSections(hasDirty: boolean, onSaveAll: () => void, run: RunActions): ToolbarSection[] {
  const sections: ToolbarSection[] = [
    [{ icon: "save", label: "Save All", disabled: !hasDirty, onClick: onSaveAll }],
    [
      { icon: "undo", label: "Undo", disabled: true },
      { icon: "redo", label: "Redo", disabled: true },
    ],
    [
      { icon: "format", label: "Format Document", disabled: true },
      { icon: "comment", label: "Toggle Comment", disabled: true },
    ],
  ];
  const gameUp = run.gameStage !== "idle" || run.debugging;
  if (run.running || gameUp) {
    const hotReload = run.onHotReload;
    sections.push([
      {
        icon: "hotReload",
        label: run.hotReloading ? "Hot Reloading…" : "Hot Reload",
        disabled: !hotReload || run.gameStage !== "ready" || run.hotReloading,
        onClick: hotReload ?? undefined,
      },
      { icon: "restart", label: "Restart", disabled: !gameUp || !run.canRestart, onClick: run.onRestart },
      { icon: "stop", label: run.debugging ? "Stop Debugging" : "Stop", disabled: !gameUp, onClick: run.onStop },
    ]);
  }
  return sections;
}

function Shell({ onOpenSettings, onOpenPublish }: { onOpenSettings: () => void; onOpenPublish: () => void }) {
  const { panels, closeTab, hasDirty, saveAll } = useOpenFiles();
  const { debugging, canRestart, restart, stop } = useDebugSessionContext();
  const { project } = useProject();
  const gameStatus = useGameStatus();
  const hotReload = useHotReload();
  const [running, setRunning] = useState(false);
  const modRoot = project?.kind === "yog-mod" ? project.root : null;
  const runActions: RunActions = {
    running,
    gameStage: gameStatus.stage,
    debugging,
    canRestart,
    onHotReload: modRoot ? () => hotReload.trigger(modRoot) : null,
    hotReloading: hotReload.busy,
    onRestart: restart,
    onStop: stop,
  };
  return (
    <PlatformShell
      main={mainPanel}
      toolWindows={toolWindows}
      persistKey="yog-idle"
      extraCenterPanels={panels}
      onCloseDynamicPanel={closeTab}
      menu={
        <>
          <Menu onOpenSettings={onOpenSettings} onOpenPublish={onOpenPublish} />
          <Toolbar leading={<RunToolbar onRunningChange={setRunning} />} sections={editorToolbarSections(hasDirty, saveAll, runActions)} />
        </>
      }
      statusBar={<StatusBar text={gameStatus.text} busy={gameStatus.busy} detail={gameStatus.lines} />}
    />
  );
}

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const { project } = useProject();

  return (
    <main className="app-root">
      <Shell onOpenSettings={() => setSettingsOpen(true)} onOpenPublish={() => setPublishOpen(true)} />
      {settingsOpen && <SettingsWindow sections={SETTINGS_SECTIONS} onClose={() => setSettingsOpen(false)} />}
      {publishOpen && project && <PublishWindow projectRoot={project.root} onClose={() => setPublishOpen(false)} />}
    </main>
  );
}

function AppWithProviders() {
  return (
    <ProjectProvider>
      <OpenFilesProvider>
        <BreakpointsProvider>
          <DebugSessionProvider>
            <App />
          </DebugSessionProvider>
        </BreakpointsProvider>
      </OpenFilesProvider>
    </ProjectProvider>
  );
}

export default AppWithProviders;
