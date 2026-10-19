import { useMemo } from "react";
import { formatShortcut, openFile, type SearchResultGroup, type SearchResultHit, SearchResults, Spacer, SymbolIcon, Toolbar, ToolbarButton, ToolbarLabel, useT } from "substrate-platform-ui";
import { cancelFind, clearFindResults, useFindResults } from "./findStore";
import { openFindInFiles } from "./searchUi";
import "./search.css";

interface Hit extends SearchResultHit {
  line?: number;
  column?: number;
}

/**
 * The Find Results tool window: what the last Find All found (streaming in
 * while it runs) or what the last Replace All changed, grouped by file.
 * Double-click or Enter opens a hit at its line and column.
 */
export function FindResultsPanel() {
  const t = useT();
  const results = useFindResults();

  const groups = useMemo<SearchResultGroup<Hit>[]>(() => {
    if (results.replaced) {
      return results.replaced.map((f) => ({
        key: f.path,
        label: f.relPath,
        detail: t("{count} replaced", { count: f.count }),
        icon: <SymbolIcon kind="file" size={14} />,
        hits: [],
      }));
    }
    return results.files.map((f) => ({
      key: f.path,
      label: f.relPath,
      detail: `(${f.hits.length})`,
      icon: <SymbolIcon kind="file" size={14} />,
      hits: f.hits.map((h) => ({
        key: `${h.line}`,
        location: `${f.relPath}(${h.line},${h.column}):`,
        text: h.text,
        ranges: h.ranges,
        line: h.line,
        column: h.column,
      })),
    }));
  }, [results.files, results.replaced, t]);

  let summary: string | null = null;
  if (results.replaced) {
    summary = t("Total replaced: {total}  Matching files: {files}", { total: results.replacedTotal, files: results.replaced.length });
  } else if (results.summary) {
    const s = results.summary;
    summary = t("Matching lines: {lines}  Matching files: {files}  Total files searched: {searched}", {
      lines: s.matchingLines,
      files: s.matchingFiles,
      searched: s.filesSearched,
    });
    if (s.truncated) summary += "  " + t("(stopped at the result limit)");
    if (s.cancelled) summary += "  " + t("(cancelled)");
  } else if (results.running) {
    summary = t("Searching…");
  }

  return (
    <div className="idle-find-results">
      <Toolbar>
        <ToolbarLabel>
          <span className="idle-find-results-caption" title={results.caption}>
            {results.caption || t("Find Results")}
          </span>
        </ToolbarLabel>
        <Spacer />
        <ToolbarButton icon="search" label="Find in Files" shortcut="ctrl+shift+f" onClick={() => openFindInFiles("find")} />
        <ToolbarButton icon="stop" label="Stop Search" disabled={!results.running} onClick={cancelFind} />
        <ToolbarButton icon="trash" label="Clear All" disabled={!results.caption} onClick={clearFindResults} />
      </Toolbar>
      {results.running && <div className="idle-find-results-progress" />}
      {results.error && <div className="idle-find-results-error">{results.error}</div>}
      <SearchResults
        groups={groups}
        summary={summary}
        emptyText={t("Use Find in Files ({keys}) to search the project.", { keys: formatShortcut("ctrl+shift+f") })}
        onActivate={(group, hit) => openFile({ path: group.key, line: hit?.line, column: hit?.column })}
      />
    </div>
  );
}
