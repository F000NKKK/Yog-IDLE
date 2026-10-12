import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { QuickPick, SymbolIcon, getEditorView, revealLine, useT, type QuickPickFilter, type QuickPickItem } from "substrate-platform-ui";
import { openFile } from "../fileOpenBus";
import { useActiveFileTab, useOpenFiles } from "../OpenFilesContext";
import { useProject } from "../ProjectContext";
import { bufferText } from "./FindInFilesWindow";
import "./search.css";

type Mode = "all" | "files" | "types" | "members" | "text";

/** Visual Studio's Code Search prefixes: typing one switches the mode. */
const PREFIXES: Record<string, Mode> = { "f:": "files", "t:": "types", "m:": "members", "x:": "text" };

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
 */
export function CodeSearch({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { project } = useProject();
  const { tabs } = useOpenFiles();
  const activeTab = useActiveFileTab();
  const [mode, setMode] = useState<Mode>("all");
  const [query, setQuery] = useState("");
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

  function onQueryChange(value: string) {
    const prefix = Object.keys(PREFIXES).find((p) => value.toLowerCase().startsWith(p));
    if (prefix) {
      setMode(PREFIXES[prefix]);
      setQuery(value.slice(prefix.length).trimStart());
    } else setQuery(value);
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
    onClose();
    openFile({ path: r.path, line: r.line ?? undefined, column: r.column ?? undefined });
  }

  function acceptQuery(): boolean {
    if (!lineQuery || !activeTab) return false;
    const view = getEditorView(activeTab.path);
    if (!view) return false;
    onClose();
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
      query={query}
      onQueryChange={onQueryChange}
      placeholder={t("Search code (Ctrl+T) — f: files, t: types, m: members, x: text, :line")}
      filters={filters}
      activeFilter={mode}
      onFilterChange={(id) => setMode(id as Mode)}
      items={lineQuery ? [] : items}
      busy={busy}
      emptyText={emptyText}
      onAccept={(item) => accept(item)}
      onAcceptQuery={acceptQuery}
      onClose={onClose}
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
