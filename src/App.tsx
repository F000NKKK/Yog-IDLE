import { PlatformShell, PalettePicker, TerminalPanel, OutputPanel } from "substrate-platform-ui";
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

const mainPanel: PanelDef = { id: "designer", title: "Designer", icon: "\u{1F5BC}", component: Designer };

const toolWindows = {
  left: [{ id: "toolbox", title: "Toolbox", icon: "\u{1F9F0}", component: Toolbox } satisfies PanelDef],
  right: [
    { id: "solutionExplorer", title: "Solution Explorer", icon: "\u{1F4C1}", component: SolutionExplorer } satisfies PanelDef,
    { id: "properties", title: "Properties", icon: "\u{1F527}", component: Properties } satisfies PanelDef,
  ],
  bottom: [
    { id: "output", title: "Output", icon: "\u{1F4CB}", component: OutputPanel } satisfies PanelDef,
    { id: "terminal", title: "Terminal", icon: "\u{2328}\u{FE0F}", component: TerminalPanel } satisfies PanelDef,
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
