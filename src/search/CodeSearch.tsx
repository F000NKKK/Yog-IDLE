import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatShortcut, getEditorView, Icon, IconButton, QuickPick, revealLine, SymbolIcon, useT, type QuickPickFilter, type QuickPickItem } from "substrate-platform-ui";
import { openFile } from "../fileOpenBus";
import { useActiveFileTab, useOpenFiles } from "../OpenFilesContext";
import { useProject } from "../ProjectContext";
import { bufferText } from "./FindInFilesWindow";
import { searchDrafts, useSearchUi } from "./searchUi";
import "./search.css";

type Mode = "all" | "files" | "types" | "members" | "text";

/** Visual Studio's Code Search prefixes: the box's text starting with one is what selects the mode. */
const PREFIXES: Record<string, Mode> = { "f:": "files", "t:": "types", "m:": "members", "x:": "text" };

/** The mode a query's prefix selects (none: All) and the text searched for. */
function splitQuery(text: string): { mode: Mode; query: string } {
  const prefix = Object.keys(PREFIXES).find((p) => text.toLowerCase().startsWith(p));
  return prefix ? { mode: PREFIXES[prefix], query: text.slice(prefix.length).trimStart() } : { mode: "all", query: text };
}

/** `text` with its prefix swapped for `mode`'s — what clicking a tab does to the box. */
function withMode(text: string, mode: Mode): string {
  const rest = splitQuery(text).mode === "all" ? text : text.replace(/^\s*[a-z]:\s*/i, "");
  const prefix = Object.keys(PREFIXES).find((p) => PREFIXES[p] === mode);
  return prefix ? `${prefix} ${rest}` : rest;
}

interface CodeSearchResult {
  kind: string;
  name: string;
  container: string | null;
  path: string;
  relPath: string;
  line: number | null;
  column: number | null;
  highlights: number[];
}

interface Item extends QuickPickItem {
  result: CodeSearchResult;
}

/** `:42` or `:42,7` — go to that line (and column) in the current document. */
function parseLineQuery(query: string): { line: number; column?: number } | null {
  const m = /^:\s*(\d+)(?:\s*[,:]\s*(\d+))?\s*$/.exec(query);
  return m ? { line: Number(m[1]), column: m[2] ? Number(m[2]) : undefined } : null;
}

/**
 * Code Search (Ctrl+T / Ctrl+,): one box for files, types, members and
 * text across the project, as in Visual Studio 2022+. `f:`, `t:`, `m:`,
 * `x:` switch the mode (or the tabs, or Tab), `:42` goes to a line in the
 * current document.
 *
 * A popup that closes once a result is opened — or, docked (`onDock`, the
 * button in its field), a tool window that stays open across navigations.
 */
export function CodeSearch({ onClose, onDock, embedded, focusKey }: { onClose?: () => void; onDock?: () => void; embedded?: boolean; focusKey?: unknown }) {
  const t = useT();
  const { project } = useProject();
  const { tabs } = useOpenFiles();
  const activeTab = useActiveFileTab();
  // The box's whole text, prefix included — editing `x:` into `f:` switches the tab.
  const [text, setTextState] = useState(searchDrafts.codeQuery);
  const { mode, query } = splitQuery(text);
  const [results, setResults] = useState<CodeSearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The first query of a session re-checks the index against disk.
  const refreshed = useRef(false);
  const requestSeq = useRef(0);

  const lineQuery = parseLineQuery(query);
  const root = project?.root ?? null;

  const filters: QuickPickFilter[] = [
    { id: "all", label: t("All") },
    { id: "files", label: t("Files"), prefix: "f:" },
    { id: "types", label: t("Types"), prefix: "t:" },
    { id: "members", label: t("Members"), prefix: "m:" },
    { id: "text", label: t("Text"), prefix: "x:" },
  ];

  function setText(next: string) {
    searchDrafts.codeQuery = next;
    setTextState(next);
  }

  useEffect(() => {
    const seq = ++requestSeq.current;
    if (!root || lineQuery || query.trim() === "") {
      setResults([]);
      setBusy(false);
      setError(null);
      return;
    }
    // Warm the index the moment the popup opens; later queries debounce.
    const delay = mode === "text" ? 200 : 60;
    const timer = setTimeout(() => {
      setBusy(true);
      const refresh = !refreshed.current;
      refreshed.current = true;
      const documents = mode === "text" ? tabs.filter((tab) => tab.textLoaded).map((tab) => ({ path: tab.path, text: bufferText(tab) })) : [];
      invoke<CodeSearchResult[]>("code_search", { request: { root, query, mode, refresh, limit: mode === "text" ? 100 : 200, documents } })
        .then((found) => {
          if (seq !== requestSeq.current) return;
          setResults(found);
          setError(null);
        })
        .catch((err) => seq === requestSeq.current && setError(String(err)))
        .finally(() => seq === requestSeq.current && setBusy(false));
    }, delay);
    return () => clearTimeout(timer);
    // `tabs` only matter for text mode's buffers at the time of the query.
  }, [root, query, mode, lineQuery !== null]);

  // Build the index in the background as soon as the popup opens, so the first keystrokes are quick.
  useEffect(() => {
    if (!root) return;
    refreshed.current = true;
    void invoke("code_search", { request: { root, query: "", mode: "types", refresh: true, limit: 1 } }).catch(() => {});
  }, [root]);

  const items = useMemo<Item[]>(
    () =>
      results.map((r, i) => ({
        key: `${i}:${r.path}:${r.line ?? 0}:${r.name}`,
        icon: <SymbolIcon kind={r.kind} size={16} />,
        label: r.name,
        highlights: r.highlights,
        description: r.container ?? undefined,
        detail: r.kind === "file" ? undefined : `${r.relPath}${r.line ? `:${r.line}` : ""}`,
        result: r,
      })),
    [results],
  );

  function accept(item: Item) {
    const r = item.result;
    onClose?.();
    openFile({ path: r.path, line: r.line ?? undefined, column: r.column ?? undefined });
  }

  function acceptQuery(): boolean {
    if (!lineQuery || !activeTab) return false;
    const view = getEditorView(activeTab.path);
    if (!view) return false;
    onClose?.();
    revealLine(view, lineQuery.line, lineQuery.column);
    return true;
  }

  let emptyText: string;
  if (lineQuery) {
    emptyText = activeTab
      ? t("Press Enter to go to line {line} in {file}", { line: lineQuery.line, file: activeTab.name })
      : t("Open a document to go to a line in it.");
  } else if (!root) emptyText = t("Open a project or folder to search its code. Type :line to go to a line.");
  else if (error) emptyText = error;
  else if (query.trim() === "") emptyText = t("Type to search files, types, members and text.");
  else if (busy) emptyText = t("Searching…");
  else emptyText = t("No results found.");

  return (
    <QuickPick<Item>
      query={text}
      onQueryChange={setText}
      placeholder={t("Search code ({keys}) — f: files, t: types, m: members, x: text, :line", { keys: formatShortcut("ctrl+t") })}
      filters={filters}
      activeFilter={mode}
      onFilterChange={(id) => setText(withMode(text, id as Mode))}
      items={lineQuery ? [] : items}
      busy={busy}
      emptyText={emptyText}
      onAccept={(item) => accept(item)}
      onAcceptQuery={acceptQuery}
      onClose={onClose}
      embedded={embedded}
      focusKey={focusKey}
      fieldActions={
        onDock && (
          <IconButton title={t("Keep open as a tool window")} onClick={onDock}>
            <Icon name="float" />
          </IconButton>
        )
      }
      footer={
        <>
          <span>
            <span className="idle-code-search-footer-key">↑↓</span> {t("navigate")}
          </span>
          <span>
            <span className="idle-code-search-footer-key">Enter</span> {t("open")}
          </span>
          <span>
            <span className="idle-code-search-footer-key">Tab</span> {t("next filter")}
          </span>
          <span>
            <span className="idle-code-search-footer-key">:</span>
            {t("line")}
          </span>
        </>
      }
    />
  );
}

/** Code Search docked as a tool window: opening a result leaves it open. */
export function CodeSearchPanel() {
  const request = useSearchUi().codeSearch;
  return (
    <div className="idle-code-search-panel">
      <CodeSearch embedded focusKey={request?.seq} />
    </div>
  );
}
