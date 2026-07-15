import {
  PlatformShell,
  PalettePicker,
  TerminalPanel,
  OutputPanel,
  IconWindow,
  IconGrid,
  IconFolder,
  IconSliders,
  IconList,
  IconTerminal,
} from "substrate-platform-ui";
import type { PanelDef } from "substrate-platform-ui";

import { Designer } from "./panels/Designer";
import { Toolbox } from "./panels/Toolbox";
import { SolutionExplorer } from "./panels/SolutionExplorer";
import { Properties } from "./panels/Properties";

import "./App.css";

// Everything below is Yog-IDLE-specific: which panels exist and where they
// sit. The shell itself (theme, docking, collapsible tool windows, the
// generic Terminal/Output panels) lives in substrate-platform-ui — Yog-IDLE
// only adds its own content on top.

const mainPanel: PanelDef = { id: "designer", title: "Designer", icon: <IconWindow />, component: Designer };

const toolWindows = {
  left: [{ id: "toolbox", title: "Toolbox", icon: <IconGrid />, component: Toolbox } satisfies PanelDef],
  right: [
    { id: "solutionExplorer", title: "Solution Explorer", icon: <IconFolder />, component: SolutionExplorer } satisfies PanelDef,
    { id: "properties", title: "Properties", icon: <IconSliders />, component: Properties } satisfies PanelDef,
  ],
  bottom: [
    { id: "output", title: "Output", icon: <IconList />, component: OutputPanel } satisfies PanelDef,
    { id: "terminal", title: "Terminal", icon: <IconTerminal />, component: TerminalPanel } satisfies PanelDef,
  ],
};

function Menu() {
  return (
    <div className="app-menu">
      <span className="app-menu-title">Yog-IDLE</span>
      <div className="app-menu-spacer" />
      <PalettePicker />
    </div>
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
