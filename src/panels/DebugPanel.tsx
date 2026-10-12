import { useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "substrate-platform-ui";
import { useDebugSessionContext } from "../DebugSessionContext";

const muted: CSSProperties = { padding: "var(--sp-space-sm)", color: "var(--sp-text-muted)" };
const mono: CSSProperties = { fontFamily: "var(--sp-font-mono)", fontSize: "12px" };
const row: CSSProperties = { ...mono, padding: "2px var(--sp-space-sm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

/** A collapsible block of the Debug panel (Call Stack / Threads / Registers). */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ borderBottom: "1px solid var(--sp-border)" }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ padding: "var(--sp-space-xs) var(--sp-space-sm)", cursor: "pointer", fontWeight: 600, userSelect: "none" }}
      >
        {open ? "▾" : "▸"} {title}
      </div>
      {open && children}
    </div>
  );
}

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** The Debug tool window: Continue/Step/Stop, plus the call stack, threads and registers from the last stop — the counterpart to Output/Terminal, docked alongside them. */
export function DebugPanel() {
  const { debugging, stopped, error, continue_, step, pause, stop, selectThread, selectedFrame, selectFrame, grantPtraceAccess } =
    useDebugSessionContext();
  const [notice, setNotice] = useState<{ text: string; isError: boolean } | null>(null);

  if (!debugging) {
    const isPermissionError = !!error && /permission denied|EPERM/i.test(error);
    return (
      <div style={{ ...muted, display: "flex", flexDirection: "column", gap: "var(--sp-space-sm)" }}>
        <div style={error ? { color: "var(--sp-danger, var(--sp-text))", whiteSpace: "pre-wrap" } : undefined}>
          {error ? `Attach failed: ${error}` : "Pick Debug mode next to the run target, then press Start."}
        </div>
        {isPermissionError && (
          <Button
            variant="ghost"
            onClick={() =>
              grantPtraceAccess()
                .then(() =>
                  setNotice({
                    text: "Granted. This only takes effect for a new launch of Yog-IDLE — restart the app, then start debugging again.",
                    isError: false,
                  }),
                )
                .catch((err) => setNotice({ text: String(err), isError: true }))
            }
            style={{ alignSelf: "flex-start" }}
          >
            Grant ptrace access…
          </Button>
        )}
        {notice && <div style={{ color: notice.isError ? "var(--sp-danger, var(--sp-text))" : "var(--sp-text)" }}>{notice.text}</div>}
      </div>
    );
  }

  const paused = !!stopped && stopped.reason !== "exited";
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", gap: "var(--sp-space-xs)", padding: "var(--sp-space-xs)", borderBottom: "1px solid var(--sp-border)", flexWrap: "wrap" }}>
        <Button variant="ghost" onClick={continue_} disabled={!paused} title="Continue (F5)">
          Continue
        </Button>
        <Button variant="ghost" onClick={pause} disabled={!!stopped} title="Break All (Ctrl+Alt+Break)">
          Pause
        </Button>
        <Button variant="ghost" onClick={() => step("over")} disabled={!paused} title="Step Over (F10)">
          Step Over
        </Button>
        <Button variant="ghost" onClick={() => step("into")} disabled={!paused} title="Step Into (F11)">
          Step Into
        </Button>
        <Button variant="ghost" onClick={() => step("out")} disabled={!paused} title="Step Out (Shift+F11)">
          Step Out
        </Button>
        <Button variant="ghost" onClick={stop} title="Stop Debugging (Shift+F5)">
          Stop
        </Button>
      </div>
      {error && <div style={{ ...muted, color: "var(--sp-danger, var(--sp-text))", whiteSpace: "pre-wrap" }}>{error}</div>}
      <div style={{ flex: 1, overflow: "auto" }}>
        {!stopped && <div style={muted}>Running…</div>}
        {stopped?.reason === "exited" && <div style={muted}>Process exited.</div>}
        {stopped && paused && (
          <>
            <Section title="Call Stack">
              {stopped.stackTrace.length === 0 && (
                <div style={muted}>{stopped.reason === "pause" ? "Paused outside mod code — pick another thread." : "No mod code on this thread's stack."}</div>
              )}
              {stopped.stackTrace.map((frame, i) => (
                <div
                  key={frame.id}
                  onClick={() => selectFrame(i)}
                  title={`${frame.file}:${frame.line}`}
                  style={{
                    ...row,
                    cursor: "pointer",
                    fontWeight: i === 0 ? 600 : undefined,
                    background: i === selectedFrame ? "var(--sp-accent-soft)" : undefined,
                  }}
                >
                  {i === 0 ? "➜ " : "   "}
                  {frame.name} — {fileName(frame.file)}:{frame.line}
                </div>
              ))}
            </Section>
            <Section title={`Threads (${stopped.threads.filter((t) => t.stopped).length} stopped / ${stopped.threads.length})`}>
              {/* Stopped ones first: only they can be inspected; the rest keep running. */}
              {[...stopped.threads].sort((a, b) => Number(b.stopped) - Number(a.stopped)).map((t) => (
                <div
                  key={t.id}
                  onClick={() => t.stopped && t.id !== stopped.thread && selectThread(t.id)}
                  title={t.stopped ? undefined : "Running — only stopped threads can be inspected"}
                  style={{
                    ...row,
                    cursor: t.stopped ? "pointer" : "default",
                    color: t.stopped ? undefined : "var(--sp-text-faint)",
                    fontWeight: t.id === stopped.thread ? 600 : undefined,
                    background: t.id === stopped.thread ? "var(--sp-accent-soft)" : undefined,
                  }}
                >
                  {t.id === stopped.thread ? "➜ " : "   "}
                  {t.id} {t.name || "<unnamed>"}
                  {!t.stopped && " (running)"}
                </div>
              ))}
            </Section>
            <Section title="Registers">
              <div style={{ display: "grid", gridTemplateColumns: "max-content 1fr", columnGap: "var(--sp-space-sm)", padding: "0 var(--sp-space-sm)", ...mono }}>
                {stopped.registers.map(([name, value]) => (
                  <div key={name} style={{ display: "contents" }}>
                    <span style={{ color: "var(--sp-text-muted)" }}>{name}</span>
                    <span style={{ userSelect: "text" }}>{value}</span>
                  </div>
                ))}
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
