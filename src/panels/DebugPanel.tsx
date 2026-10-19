import { useState, type CSSProperties, type ReactNode } from "react";
import { Button, formatShortcut, invokeCommand, t, useT } from "substrate-platform-ui";
import { useDebugSessionContext } from "../DebugSessionContext";
import { AutosView, LocalsView, useLocals, WatchView } from "../debugger/VariableWindows";
import { yog } from "../plugins.generated";

const muted: CSSProperties = { padding: "var(--sp-space-sm)", color: "var(--sp-text-muted)" };
const mono: CSSProperties = { fontFamily: "var(--sp-font-mono)", fontSize: "var(--sp-font-size-sm)" };
const row: CSSProperties = { ...mono, height: "var(--sp-row-height)", lineHeight: "var(--sp-row-height)", padding: "0 var(--sp-space-sm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

/** A collapsible block of the Debug panel (Watch / Autos / Locals / Call Stack / Threads / Registers). */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ borderBottom: "1px solid var(--sp-border)" }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", alignItems: "center", gap: "var(--sp-space-xs)", height: "var(--sp-control-height)", padding: "0 var(--sp-space-sm)", cursor: "pointer", fontWeight: 600, userSelect: "none" }}
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

/** How the Debug panel introduces an error, by where it came from (see `useDebugSession`). */
function errorPrefix(kind: "attach" | "session" | null): string {
  if (kind === "attach") return t("Attach failed: ");
  if (kind === "session") return t("Debugging stopped — the debugger failed: ");
  return "";
}

/** The Debug tool window: Continue/Step/Stop, plus the locals, call stack, threads and registers from the last stop — the counterpart to Output/Terminal, docked alongside them. */
export function DebugPanel() {
  const { debugging, stopped, error, errorKind, continue_, step, pause, stop, selectThread, selectedFrame, selectFrame, grantPtraceAccess } =
    useDebugSessionContext();
  const t = useT();
  /** `t`, for where a thread named `t` shadows it. */
  const tr = t;
  const withShortcut = (label: string, shortcut: string) => `${t(label)} (${formatShortcut(shortcut)})`;
  const [notice, setNotice] = useState<{ text: string; isError: boolean } | null>(null);
  const [granted, setGranted] = useState(false);
  // What's expanded in each variable window, kept across stops (the
  // windows themselves unmount while the game runs).
  const watchExpanded = useState<ReadonlySet<string>>(new Set());
  const autosExpanded = useState<ReadonlySet<string>>(new Set());
  const localsExpanded = useState<ReadonlySet<string>>(new Set());
  const paused = !!stopped && stopped.reason !== "exited";
  const frame = paused && stopped ? (stopped.stackTrace[selectedFrame] ?? null) : null;
  const { locals, error: localsError } = useLocals(stopped, frame?.id ?? null);

  if (!debugging) {
    // `permission_denied_message` (debugger.rs) tags what fixes an EPERM;
    // only a policy that really refuses us needs the capability grant.
    const needsCapability = !!error && error.startsWith("[needs-capability]");
    const message = error?.replace(/^\[[a-z-]+\] /, "");
    return (
      <div style={{ ...muted, display: "flex", flexDirection: "column", gap: "var(--sp-space-sm)" }}>
        <div style={error ? { color: "var(--sp-danger)", whiteSpace: "pre-wrap" } : undefined}>
          {error ? `${errorPrefix(errorKind)}${message}` : t("Pick Debug mode next to the run target, then press Start.")}
        </div>
        {needsCapability && !granted && (
          <Button
            variant="ghost"
            onClick={() =>
              grantPtraceAccess()
                .then(() => {
                  setGranted(true);
                  setNotice(null);
                })
                .catch((err) => setNotice({ text: String(err), isError: true }))
            }
            style={{ alignSelf: "flex-start" }}
          >
            {t("Grant ptrace access…")}
          </Button>
        )}
        {granted && (
          <>
            <div style={{ color: "var(--sp-text)" }}>{t("Granted — it applies from the next start of Yog-IDLE.")}</div>
            <Button variant="ghost" onClick={() => invokeCommand(yog.app.appRestart)} style={{ alignSelf: "flex-start" }}>
              {t("Restart Yog-IDLE")}
            </Button>
          </>
        )}
        {notice && <div style={{ color: notice.isError ? "var(--sp-danger)" : "var(--sp-text)" }}>{notice.text}</div>}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--sp-space-2xs) var(--sp-toolbar-gap)", minHeight: "var(--sp-toolbar-height)", padding: "var(--sp-toolbar-padding-y) var(--sp-toolbar-padding-x)", borderBottom: "1px solid var(--sp-border)" }}>
        <Button variant="ghost" onClick={continue_} disabled={!paused} title={withShortcut("Continue", "F5")}>
          {t("Continue")}
        </Button>
        <Button variant="ghost" onClick={pause} disabled={!!stopped} title={withShortcut("Break All", "Ctrl+Alt+Break")}>
          {t("Pause")}
        </Button>
        <Button variant="ghost" onClick={() => step("over")} disabled={!paused} title={withShortcut("Step Over", "F10")}>
          {t("Step Over")}
        </Button>
        <Button variant="ghost" onClick={() => step("into")} disabled={!paused} title={withShortcut("Step Into", "F11")}>
          {t("Step Into")}
        </Button>
        <Button variant="ghost" onClick={() => step("out")} disabled={!paused} title={withShortcut("Step Out", "Shift+F11")}>
          {t("Step Out")}
        </Button>
        <Button variant="ghost" onClick={stop} title={withShortcut("Stop Debugging", "Shift+F5")}>
          {t("Stop")}
        </Button>
      </div>
      {error && <div style={{ ...muted, color: "var(--sp-danger)", whiteSpace: "pre-wrap" }}>{error}</div>}
      <div style={{ flex: 1, overflow: "auto" }}>
        {!stopped && <div style={muted}>{t("Running…")}</div>}
        {stopped?.reason === "exited" && <div style={muted}>{t("Process exited.")}</div>}
        {stopped && paused && (
          <>
            <Section title={t("Watch")}>
              <WatchView stopKey={stopped} frame={frame?.id ?? null} expanded={watchExpanded} />
            </Section>
            <Section title={t("Autos")}>
              <AutosView locals={locals} file={frame?.file ?? null} line={frame?.line ?? null} expanded={autosExpanded} />
            </Section>
            <Section title={t("Locals")}>
              <LocalsView locals={locals} error={localsError} expanded={localsExpanded} />
            </Section>
            <Section title={t("Call Stack")}>
              {stopped.stackTrace.length === 0 && (
                <div style={muted}>{stopped.reason === "pause" ? t("Paused outside mod code — pick another thread.") : t("No mod code on this thread's stack.")}</div>
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
            <Section
              title={t("Threads ({stopped} stopped / {count})", {
                stopped: stopped.threads.filter((th) => th.stopped).length,
                count: stopped.threads.length,
              })}
            >
              {/* Stopped ones first: only they can be inspected; the rest keep running. */}
              {[...stopped.threads].sort((a, b) => Number(b.stopped) - Number(a.stopped)).map((t) => (
                <div
                  key={t.id}
                  onClick={() => t.stopped && t.id !== stopped.thread && selectThread(t.id)}
                  title={t.stopped ? undefined : tr("Running — only stopped threads can be inspected")}
                  style={{
                    ...row,
                    cursor: t.stopped ? "pointer" : "default",
                    color: t.stopped ? undefined : "var(--sp-text-faint)",
                    fontWeight: t.id === stopped.thread ? 600 : undefined,
                    background: t.id === stopped.thread ? "var(--sp-accent-soft)" : undefined,
                  }}
                >
                  {t.id === stopped.thread ? "➜ " : "   "}
                  {t.id} {t.name || tr("<unnamed>")}
                  {!t.stopped && ` ${tr("(running)")}`}
                </div>
              ))}
            </Section>
            <Section title={t("Registers")}>
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
