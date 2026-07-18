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
  useWorkflowRunner,
} from "substrate-platform-ui";
import type { PanelDef, SettingsSection } from "substrate-platform-ui";

import { Editor } from "./panels/Editor";
import { Toolbox } from "./panels/Toolbox";
import { SolutionExplorer } from "./panels/SolutionExplorer";
import { Properties } from "./panels/Properties";
import { RunToolbar } from "./panels/RunToolbar";
import { ProjectProvider, useProject } from "./ProjectContext";
import { requestOpenFile } from "./fileOpenBus";

import "./App.css";

// Everything below is Yog-IDLE-specific: which panels exist, where they
// start docked, and what the menu/settings contain. The shell itself
// (theme, docking, drag-to-redock/float, the generic Terminal/Output
// panels, the Settings window chrome) lives in substrate-platform-ui —
// Yog-IDLE only adds its own content on top.

const mainPanel: PanelDef = { id: "editor", title: "Editor", component: Editor };

/** Output panel wired to the workflow engine's live-output event — every `workflow_run` line lands here, the same way PTY output streams into the Terminal panel. */
function BuildOutputPanel() {
  return <OutputPanel eventName="workflow-output" emptyLabel="Run a Build command to see output here." />;
}

const toolWindows = {
  left: [{ id: "toolbox", title: "Toolbox", component: Toolbox } satisfies PanelDef],
  right: [
    { id: "solutionExplorer", title: "Solution Explorer", component: SolutionExplorer } satisfies PanelDef,
    { id: "properties", title: "Properties", component: Properties } satisfies PanelDef,
  ],
  bottom: [
    { id: "output", title: "Output", component: BuildOutputPanel } satisfies PanelDef,
    { id: "terminal", title: "Terminal", component: TerminalPanel } satisfies PanelDef,
  ],
};

const SETTINGS_SECTIONS: SettingsSection[] = [{ id: "appearance", label: "Appearance", content: <AppearanceSettings /> }];

/** The "Build" menu's real dropdown — every workflow the opened project defines, each running via `workflow_run` with output landing in `BuildOutputPanel`. Only rendered once a project is actually open. */
function BuildMenu() {
  const { project } = useProject();
  if (!project) return <MenuBarItem label="Build" />;
  return <BuildMenuItems root={project.root} kind={project.kind} />;
}

function BuildMenuItems({ root, kind }: { root: string; kind: string | null }) {
  const runner = useWorkflowRunner(root, kind ?? undefined);
  return <MenuBarItem label="Build" items={runner.workflows.map((w) => ({ label: w.name, onClick: () => runner.run(w.name) }))} />;
}

/** File > Open Folder/Open Project/Open File, backed by the native OS picker (`@tauri-apps/plugin-dialog`). Open Folder/Project both replace the current project via `ProjectContext`; Open File just opens a single file as an editor tab, expanding the allowed-path boundary to cover it (see `allow_path` on the Rust side) since it needn't belong to any open project. */
function FileMenu() {
  const { openPath } = useProject();

  async function openFolder() {
    const chosen = await open({ directory: true });
    if (typeof chosen === "string") await openPath(chosen);
  }

  async function openProject() {
    const chosen = await open({ filters: [{ name: "Yog Solution", extensions: ["yogsln"] }] });
    if (typeof chosen === "string") await openPath(chosen);
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

function Menu({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <MenuBar title="Yog IDLE" windowControls={<WindowControls />}>
      <FileMenu />
      <MenuBarItem label="Edit" />
      <MenuBarItem label="View" />
      <BuildMenu />
      <MenuBarItem label="Debug" />
      <MenuBarItem label="Tools" items={[{ label: "Options...", onClick: onOpenSettings }]} />
      <MenuBarItem label="Help" />
    </MenuBar>
  );
}

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <main className="app-root">
      <ProjectProvider>
        <PlatformShell
          main={mainPanel}
          toolWindows={toolWindows}
          persistKey="yog-idle"
          menu={
            <>
              <Menu onOpenSettings={() => setSettingsOpen(true)} />
              <RunToolbar />
            </>
          }
        />
      </ProjectProvider>
      {settingsOpen && <SettingsWindow sections={SETTINGS_SECTIONS} onClose={() => setSettingsOpen(false)} />}
    </main>
  );
}

export default App;
