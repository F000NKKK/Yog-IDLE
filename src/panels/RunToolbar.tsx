import { RunBar, useWorkflowRunner } from "substrate-platform-ui";
import { useProject, type ProjectInfo } from "../ProjectContext";
import { useModRunTargets } from "../useModRunTargets";

/**
 * Picks the right run-target source for the open project's kind and hands
 * it to the generic `RunBar`: a `yog-mod` project's targets come from its
 * own `yog.toml` (`[run.*]`, executed via `yog run <name>`); anything else
 * falls back to the generic workflow engine, for a project that happens to
 * define its own `workflow.toml`.
 */
export function RunToolbar() {
  const { project } = useProject();
  if (!project) return <RunBar targets={[]} running={false} onRun={() => {}} />;
  return project.kind === "yog-mod" ? <ModRunToolbar root={project.root} /> : <WorkflowRunToolbar root={project.root} />;
}

function ModRunToolbar({ root }: { root: string }) {
  const { targets, running, run } = useModRunTargets(root);
  return <RunBar targets={targets} running={running} onRun={run} />;
}

function WorkflowRunToolbar({ root }: { root: string }) {
  const runner = useWorkflowRunner(root);
  return <RunBar targets={runner.workflows} running={runner.running} onRun={runner.run} />;
}

// Kept for backward reference by App.tsx's import — see `ProjectContext` for the shared project shape.
export type { ProjectInfo };
