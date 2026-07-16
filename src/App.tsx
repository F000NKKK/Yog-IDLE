import { useState } from "react";
import {
  PlatformShell,
  MenuBar,
  MenuBarItem,
  TerminalPanel,
  OutputPanel,
  SettingsWindow,
  AppearanceSettings,
  WindowControls,
} from "substrate-platform-ui";
import type { PanelDef, SettingsSection } from "substrate-platform-ui";

import { Designer } from "./panels/Designer";
import { Toolbox } from "./panels/Toolbox";
import { SolutionExplorer } from "./panels/SolutionExplorer";
import { Properties } from "./panels/Properties";

import "./App.css";

// Everything below is Yog-IDLE-specific: which panels exist, where they
// start docked, and what the menu/settings contain. The shell itself
// (theme, docking, drag-to-redock/float, the generic Terminal/Output
// panels, the Settings window chrome) lives in substrate-platform-ui —
// Yog-IDLE only adds its own content on top.

const mainPanel: PanelDef = { id: "designer", title: "Designer", component: Designer };

const toolWindows = {
  left: [{ id: "toolbox", title: "Toolbox", component: Toolbox } satisfies PanelDef],
  right: [
    { id: "solutionExplorer", title: "Solution Explorer", component: SolutionExplorer } satisfies PanelDef,
    { id: "properties", title: "Properties", component: Properties } satisfies PanelDef,
  ],
  bottom: [
    { id: "output", title: "Output", component: OutputPanel } satisfies PanelDef,
    { id: "terminal", title: "Terminal", component: TerminalPanel } satisfies PanelDef,
  ],
};

const MENU_ITEMS = ["File", "Edit", "View", "Build", "Debug"];

const SETTINGS_SECTIONS: SettingsSection[] = [{ id: "appearance", label: "Appearance", content: <AppearanceSettings /> }];

function Menu({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <MenuBar title="Yog IDLE" windowControls={<WindowControls />}>
      {MENU_ITEMS.map((label) => (
        <MenuBarItem key={label} label={label} />
      ))}
      <MenuBarItem label="Tools" items={[{ label: "Options...", onClick: onOpenSettings }]} />
      <MenuBarItem label="Help" />
    </MenuBar>
  );
}

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <main className="app-root">
      <PlatformShell main={mainPanel} toolWindows={toolWindows} menu={<Menu onOpenSettings={() => setSettingsOpen(true)} />} />
      {settingsOpen && <SettingsWindow sections={SETTINGS_SECTIONS} onClose={() => setSettingsOpen(false)} />}
    </main>
  );
}

export default App;
