import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  PlatformShell,
  MenuBar,
  MenuBarItem,
  TerminalPanel,
  OutputPanel,
  SettingsWindow,
  AppearanceSettings,
  WindowControls,
  Toolbar,
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
import { ProjectProvider, useProject } from "./ProjectContext";
import { OpenFilesProvider, useOpenFiles } from "./OpenFilesContext";
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

/** Output panel wired to the workflow engine's live-output event — every `workflow_run` line lands here, the same way PTY output streams into the Terminal panel. */
function BuildOutputPanel() {
  return <OutputPanel eventName="workflow-output" emptyLabel="Run a Build command to see output here." />;
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

function ModBuildMenu({ root, onOpenPublish }: { root: string; onOpenPublish: () => void }) {
  return (
    <MenuBarItem
      label="Build"
      items={[
        { label: "Build", onClick: () => invoke("mod_build", { projectRoot: root }) },
        { label: "Publish...", onClick: onOpenPublish },
      ]}
    />
  );
}

function WorkflowBuildMenu({ root }: { root: string }) {
  const runner = useWorkflowRunner(root);
  const items = runner.workflows.filter((w) => isBasicBuildWorkflow(w.name)).map((w) => ({ label: w.name, onClick: () => runner.run(w.name) }));
  return <MenuBarItem label="Build" items={items} />;
}

/** File > Open Folder/Open Project/Open File, backed by the native OS picker (`@tauri-apps/plugin-dialog`). Open Folder/Project both replace the current project via `ProjectContext`; Open File just opens a single file as an editor tab, expanding the allowed-path boundary to cover it (see `allow_path` on the Rust side) since it needn't belong to any open project. */
function FileMenu() {
  const { openPath } = useProject();

  async function openFolder() {
    const chosen = await open({ directory: true });
    if (typeof chosen === "string") await openPath(chosen);
  }

  async function openProject() {
    // Yog-IDLE has no "solution" file format — a project *is* a `yog.toml`.
    // The native dialog can only filter by extension, not filename, so this
    // guides the user toward picking one; we then use its parent folder as
    // the project root.
    const chosen = await open({ filters: [{ name: "Yog Project (yog.toml)", extensions: ["toml"] }] });
    if (typeof chosen !== "string") return;
    const dir = chosen.slice(0, Math.max(chosen.lastIndexOf("/"), chosen.lastIndexOf("\\")));
    await openPath(dir);
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
        { label: "Open Folder...", onClick: openFolder },
        { label: "Open Project...", onClick: openProject },
        { label: "Open File...", onClick: openFile },
      ]}
    />
  );
}

function Menu({ onOpenSettings, onOpenPublish }: { onOpenSettings: () => void; onOpenPublish: () => void }) {
  return (
    <MenuBar title="Yog IDLE" windowControls={<WindowControls />}>
      <FileMenu />
      <MenuBarItem label="Edit" />
      <MenuBarItem label="View" />
      <BuildMenu onOpenPublish={onOpenPublish} />
      <MenuBarItem label="Debug" />
      <MenuBarItem label="Tools" items={[{ label: "Options...", onClick: onOpenSettings }]} />
      <MenuBarItem label="Help" />
    </MenuBar>
  );
}

/**
 * The editor action toolbar — Save is real (saves every dirty open file);
 * Undo/Redo/Format/Toggle Comment are disabled placeholders for now (wiring
 * them needs a way to reach "whichever editor is currently focused", which
 * doesn't exist yet). Hot Reload/Restart/Stop only appear once something is
 * actually running/debugging (there's no debugger/hot-reload backend yet —
 * see the loader's planned `yog-debugger`/`yog-hot-reload` crates — so they
 * stay disabled placeholders for now too, but shouldn't clutter the bar
 * while nothing is running).
 */
function editorToolbarSections(hasDirty: boolean, onSaveAll: () => void, running: boolean): ToolbarSection[] {
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
  if (running) {
    sections.push([
      { icon: "hotReload", label: "Hot Reload", disabled: true },
      { icon: "restart", label: "Restart", disabled: true },
      { icon: "stop", label: "Stop Debugging", disabled: true },
    ]);
  }
  return sections;
}

function Shell({ onOpenSettings, onOpenPublish }: { onOpenSettings: () => void; onOpenPublish: () => void }) {
  const { panels, closeTab, hasDirty, saveAll } = useOpenFiles();
  const [running, setRunning] = useState(false);
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
          <Toolbar leading={<RunToolbar onRunningChange={setRunning} />} sections={editorToolbarSections(hasDirty, saveAll, running)} />
        </>
      }
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
        <App />
      </OpenFilesProvider>
    </ProjectProvider>
  );
}

export default AppWithProviders;
