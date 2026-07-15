import { PlatformShell, MenuBar, MenuBarItem, PalettePicker, TerminalPanel, OutputPanel } from "substrate-platform-ui";
import type { PanelDef } from "substrate-platform-ui";

import { Designer } from "./panels/Designer";
import { Toolbox } from "./panels/Toolbox";
import { SolutionExplorer } from "./panels/SolutionExplorer";
import { Properties } from "./panels/Properties";

import "./App.css";

// Everything below is Yog-IDLE-specific: which panels exist, where they
// start docked, and what the menu contains. The shell itself (theme,
// docking, drag-to-redock/float, the generic Terminal/Output panels) lives
// in substrate-platform-ui — Yog-IDLE only adds its own content on top.

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

const MENU_ITEMS = ["File", "Edit", "View", "Build", "Debug", "Help"];

function Menu() {
  return (
    <MenuBar title="Yog-IDLE" actions={<PalettePicker />}>
      {MENU_ITEMS.map((label) => (
        <MenuBarItem key={label} label={label} />
      ))}
    </MenuBar>
  );
}

function App() {
  return (
    <main className="app-root">
      <PlatformShell main={mainPanel} toolWindows={toolWindows} menu={<Menu />} />
    </main>
  );
}

export default App;
