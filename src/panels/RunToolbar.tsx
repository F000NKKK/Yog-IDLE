import { useEffect } from "react";
import { RunBar, type RunMode, useWorkflowRunner, useWorkspaceState } from "substrate-platform-ui";
import { useProject } from "../project/ProjectContext";
import { useModRunTargets } from "../running/useModRunTargets";
import { useDebugSessionContext } from "../debugger/DebugSessionContext";

export interface RunToolbarProps {
  /** Reports the run-target source's live `running` state up to the shell, so it can conditionally show Restart/Stop instead of leaving them permanently visible-but-disabled. */
  onRunningChange?: (running: boolean) => void;
}

/**
 * Picks the right run-target source for the open project's kind and hands
 * it to the generic `RunBar`: a `yog-mod` project's targets come from Yog's
 * home (`yog run --list`: a loader and a Minecraft version, picked apart),
 * executed via `yog run <name>`; anything else
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

/** "Debug"/"Release" aren't fixed by `RunBar` — this is where Yog-IDLE decides what they mean: a debug-mode run builds with debug symbols and attaches `yog-debugger` the moment the game reports its real pid (see `mod_run`/`debugger::run_with_mode` on the Rust side). */
const MOD_RUN_MODES: RunMode[] = [
  { name: "release", label: "Release" },
  { name: "debug", label: "Debug" },
];

function ModRunToolbar({ root, onRunningChange }: { root: string } & RunToolbarProps) {
  const { targets, running, run } = useModRunTargets(root);
  const { notifyRun } = useDebugSessionContext();
  // Remembered per project, like the target itself (see `RunBar`).
  const [mode, setMode] = useWorkspaceState("run.mode", "release", (v) => typeof v === "string");
  useEffect(() => onRunningChange?.(running), [running, onRunningChange]);
  const effectiveMode = MOD_RUN_MODES.some((m) => m.name === mode) ? mode : "release";
  return (
    <RunBar
      targets={targets}
      running={running}
      onRun={(name) => {
        notifyRun(() => run(name, effectiveMode));
        run(name, effectiveMode);
      }}
      modes={MOD_RUN_MODES}
      selectedMode={effectiveMode}
      onModeChange={setMode}
    />
  );
}

function WorkflowRunToolbar({ root, onRunningChange }: { root: string } & RunToolbarProps) {
  const runner = useWorkflowRunner(root);
  const { notifyRun } = useDebugSessionContext();
  useEffect(() => onRunningChange?.(runner.running), [runner.running, onRunningChange]);
  return (
    <RunBar
      targets={runner.workflows}
      running={runner.running}
      onRun={(name) => {
        notifyRun(() => runner.run(name));
        runner.run(name);
      }}
    />
  );
}
