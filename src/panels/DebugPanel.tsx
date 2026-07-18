import { Button } from "substrate-platform-ui";
import { useDebugSessionContext } from "../DebugSessionContext";
import { requestOpenFile } from "../fileOpenBus";

/** The Debug tool window: call stack from the last stop, plus Continue/Step — the counterpart to Output/Terminal, docked alongside them. */
export function DebugPanel() {
  const { debugging, stopped, error, continue_, step, grantPtraceAccess } = useDebugSessionContext();

  if (!debugging) {
    const isPermissionError = !!error && /permission denied|EPERM/i.test(error);
    return (
      <div style={{ padding: "var(--sp-space-sm)", color: "var(--sp-text-muted)", display: "flex", flexDirection: "column", gap: "var(--sp-space-sm)" }}>
        <div>{error ? `Attach failed: ${error}` : "Pick Debug mode next to the run target, then press Start."}</div>
        {isPermissionError && (
          <Button variant="ghost" onClick={() => grantPtraceAccess().catch((err) => alert(String(err)))} style={{ alignSelf: "flex-start" }}>
            Grant ptrace access…
          </Button>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", gap: "var(--sp-space-xs)", padding: "var(--sp-space-xs)", borderBottom: "1px solid var(--sp-border)" }}>
        <Button variant="ghost" onClick={continue_} disabled={!stopped || stopped.reason === "exited"}>
          Continue
        </Button>
        <Button variant="ghost" onClick={step} disabled={!stopped || stopped.reason === "exited"}>
          Step
        </Button>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {!stopped && <div style={{ padding: "var(--sp-space-sm)", color: "var(--sp-text-muted)" }}>Running…</div>}
        {stopped?.reason === "exited" && <div style={{ padding: "var(--sp-space-sm)", color: "var(--sp-text-muted)" }}>Process exited.</div>}
        {stopped && stopped.reason !== "exited" && (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {stopped.stackTrace.map((frame) => (
              <li
                key={frame.id}
                onClick={() => requestOpenFile({ path: frame.file, name: frame.file.split(/[/\\]/).pop() ?? frame.file })}
                style={{
                  padding: "var(--sp-space-xs) var(--sp-space-sm)",
                  cursor: "pointer",
                  fontFamily: "var(--sp-font-mono)",
                  fontSize: "12px",
                }}
              >
                {frame.name} — {frame.file.split(/[/\\]/).pop()}:{frame.line}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
