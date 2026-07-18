import { useEffect } from "react";
import { RunBar, useWorkflowRunner } from "substrate-platform-ui";
import { useProject } from "../ProjectContext";
import { useModRunTargets } from "../useModRunTargets";

export interface RunToolbarProps {
  /** Reports the run-target source's live `running` state up to the shell, so it can conditionally show Restart/Stop instead of leaving them permanently visible-but-disabled. */
  onRunningChange?: (running: boolean) => void;
}

/**
 * Picks the right run-target source for the open project's kind and hands
 * it to the generic `RunBar`: a `yog-mod` project's targets come from its
 * own `yog.toml` (`[run.*]`, executed via `yog run <name>`); anything else
 * falls back to the generic workflow engine, for a project that happens to
 * define its own `workflow.toml`.
 */
export function RunToolbar({ onRunningChange }: RunToolbarProps = {}) {
  const { project } = useProject();
  if (!project) return <RunBar targets={[]} running={false} onRun={() => {}} />;
  return project.kind === "yog-mod" ? (
    <ModRunToolbar root={project.root} onRunningChange={onRunningChange} />
  ) : (
    <WorkflowRunToolbar root={project.root} onRunningChange={onRunningChange} />
  );
}

function ModRunToolbar({ root, onRunningChange }: { root: string } & RunToolbarProps) {
  const { targets, running, run } = useModRunTargets(root);
  useEffect(() => onRunningChange?.(running), [running, onRunningChange]);
  return <RunBar targets={targets} running={running} onRun={run} />;
}

function WorkflowRunToolbar({ root, onRunningChange }: { root: string } & RunToolbarProps) {
  const runner = useWorkflowRunner(root);
  useEffect(() => onRunningChange?.(runner.running), [runner.running, onRunningChange]);
  return <RunBar targets={runner.workflows} running={runner.running} onRun={runner.run} />;
}
