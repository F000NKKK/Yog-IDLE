import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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

import { Designer } from "./panels/Designer";
import { Toolbox } from "./panels/Toolbox";
import { SolutionExplorer } from "./panels/SolutionExplorer";
import { Properties } from "./panels/Properties";
import { DEV_SOLUTION_PATH } from "./devSolution";

import "./App.css";

// Everything below is Yog-IDLE-specific: which panels exist, where they
// start docked, and what the menu/settings contain. The shell itself
// (theme, docking, drag-to-redock/float, the generic Terminal/Output
// panels, the Settings window chrome) lives in substrate-platform-ui —
// Yog-IDLE only adds its own content on top.

const mainPanel: PanelDef = { id: "designer", title: "Designer", component: Designer };

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

interface ProjectInfo {
  name: string;
  root: string;
  kind: string | null;
}

/** The "Build" menu's real dropdown — every workflow the opened project defines, each running via `workflow_run` with output landing in `BuildOutputPanel`. Only rendered once a project is actually open. */
function BuildMenuItems({ project }: { project: ProjectInfo }) {
  const runner = useWorkflowRunner(project.root, project.kind ?? undefined);
  return <MenuBarItem label="Build" items={runner.workflows.map((w) => ({ label: w.name, onClick: () => runner.run(w.name) }))} />;
}

function BuildMenu() {
  const [project, setProject] = useState<ProjectInfo | null>(null);

  useEffect(() => {
    invoke<{ name: string; projects: ProjectInfo[] }>("solution_open", { path: DEV_SOLUTION_PATH })
      .then((solution) => setProject(solution.projects[0] ?? null))
      .catch(() => setProject(null));
  }, []);

  return project ? <BuildMenuItems project={project} /> : <MenuBarItem label="Build" />;
}

function Menu({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <MenuBar title="Yog IDLE" windowControls={<WindowControls />}>
      <MenuBarItem label="File" />
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
      <PlatformShell
        main={mainPanel}
        toolWindows={toolWindows}
        persistKey="yog-idle"
        menu={<Menu onOpenSettings={() => setSettingsOpen(true)} />}
      />
      {settingsOpen && <SettingsWindow sections={SETTINGS_SECTIONS} onClose={() => setSettingsOpen(false)} />}
    </main>
  );
}

export default App;
