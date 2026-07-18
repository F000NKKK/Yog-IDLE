import { useEffect, useState } from "react";
import { IconButton, Icon, ContextMenu, useContextMenu, useWorkflowRunner } from "substrate-platform-ui";
import { useProject, type ProjectInfo } from "../ProjectContext";
import "./RunToolbar.css";

/**
 * A Visual Studio-style run bar: pick a target (one of the project's
 * workflows — "Run Fabric Client", etc.) from a dropdown, then hit the solid
 * green Start arrow to launch it via the workflow engine. Sits below the
 * menu bar as its own row, mirroring VS's startup-item selector + Start button.
 */
export function RunToolbar() {
  const { project } = useProject();
  if (!project) return <div className="sp-run-toolbar" />;
  return <RunToolbarContent project={project} />;
}

function RunToolbarContent({ project }: { project: ProjectInfo }) {
  const runner = useWorkflowRunner(project.root, project.kind ?? undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const menu = useContextMenu<void>();

  useEffect(() => {
    if (selected || runner.workflows.length === 0) return;
    // Prefer a "run"-named workflow as the default target, the same way VS
    // defaults its Start button to the solution's startup project.
    const preferred = runner.workflows.find((w) => w.name.toLowerCase().includes("run")) ?? runner.workflows[0];
    setSelected(preferred.name);
  }, [runner.workflows, selected]);

  const selectedSummary = runner.workflows.find((w) => w.name === selected);

  return (
    <div className="sp-run-toolbar">
      <IconButton
        size={26}
        title={selectedSummary ? `Run: ${selectedSummary.name}` : "Select a target first"}
        disabled={!selected || runner.running}
        className="sp-run-toolbar-play"
        onClick={() => selected && runner.run(selected)}
      >
        <Icon name="play" size={15} />
      </IconButton>
      <div className="sp-run-toolbar-target-anchor">
        <button
          type="button"
          className="sp-run-toolbar-target"
          disabled={runner.workflows.length === 0}
          onClick={() => menu.openAtAnchor()}
        >
          <span>{selectedSummary?.description ?? selectedSummary?.name ?? "No targets"}</span>
          <Icon name="chevronRight" size={11} className="sp-run-toolbar-chevron" />
        </button>
        <ContextMenu
          target={menu.target ? { mode: "anchor" } : null}
          items={runner.workflows.map((w) => ({
            label: w.description ?? w.name,
            checked: w.name === selected,
            onSelect: () => setSelected(w.name),
          }))}
          onClose={menu.close}
        />
      </div>
    </div>
  );
}
