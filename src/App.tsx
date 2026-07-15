import { DockviewReact, DockviewReadyEvent } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";

import { Designer } from "./panels/Designer";
import { Toolbox } from "./panels/Toolbox";
import { SolutionExplorer } from "./panels/SolutionExplorer";
import { Properties } from "./panels/Properties";
import { Output } from "./panels/Output";
import { Terminal } from "./panels/Terminal";

import "./App.css";

// Panel layout is modeled after Visual Studio: a Toolbox on the left, a
// Solution Explorer + Properties stack on the right, an Output + Terminal
// pair along the bottom, and the Designer canvas filling the center.

const components = {
    designer: Designer,
    toolbox: Toolbox,
    solutionExplorer: SolutionExplorer,
    properties: Properties,
    output: Output,
    terminal: Terminal,
};

function onReady(event: DockviewReadyEvent) {
    const api = event.api;

    api.addPanel({ id: "designer", component: "designer", title: "Designer" });
    api.addPanel({
        id: "toolbox",
        component: "toolbox",
        title: "Toolbox",
        position: { referencePanel: "designer", direction: "left" },
        initialWidth: 220,
    });
    api.addPanel({
        id: "solutionExplorer",
        component: "solutionExplorer",
        title: "Solution Explorer",
        position: { referencePanel: "designer", direction: "right" },
        initialWidth: 280,
    });
    api.addPanel({
        id: "properties",
        component: "properties",
        title: "Properties",
        position: { referencePanel: "solutionExplorer", direction: "below" },
    });
    api.addPanel({
        id: "output",
        component: "output",
        title: "Output",
        position: { referencePanel: "designer", direction: "below" },
        initialHeight: 220,
    });
    api.addPanel({
        id: "terminal",
        component: "terminal",
        title: "Terminal",
        position: { referencePanel: "output", direction: "within" },
    });
}

function App() {
    return (
        <main className="app-root">
            <DockviewReact className="dockview-theme-vs" components={components} onReady={onReady} />
        </main>
    );
}

export default App;
