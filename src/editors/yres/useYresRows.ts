// The grid's rows and their problems.

import { useMemo } from "react";
import type { EditorProps } from "substrate-platform-ui";
import { resKind } from "../../data/yogIds.generated";
import { yresFileName } from "../../lang/yres";
import type { YresFile } from "./useYresFile";
import type { YresSiblings } from "./useYresSiblings";
import { NEW_ROW_ID, type Row, type Sibling } from "./yresModel";

/** The grid's rows and their problems. */
export function useYresRows(props: EditorProps, yresFile: YresFile, yresSiblings: YresSiblings) {
  const { readOnly } = props;
  const { t, entries, set, isCulture, query, showAll, siblings } = yresFile;
  const { neutral, shownSiblings } = yresSiblings;
  // ── Rows and validation ─────────────────────────────────────────────────

  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const accessors = new Map<string, number>();
    for (const e of entries) {
      counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
      if (e.accessor) accessors.set(e.accessor, (accessors.get(e.accessor) ?? 0) + 1);
    }
    return { counts, accessors };
  }, [entries]);

  const rows = useMemo<Row[]>(() => {
    const all = entries.map((e, index) => ({ id: `r${index}`, index, name: e.name, type: e.type, value: e.value, comment: e.comment ?? "", accessor: e.accessor, problem: e.nameProblem, valueProblem: e.valueProblem, argb: e.argb }));
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (r) =>
        [r.name, String(r.value), r.comment].some((s) => s.toLowerCase().includes(needle)) ||
        shownSiblings.some((s) => s.texts.get(r.name)?.toLowerCase().includes(needle))
    );
  }, [entries, query, shownSiblings]);

  const newRow = useMemo<Row[]>(
    () => (readOnly ? [] : [{ id: NEW_ROW_ID, index: -1, name: "", type: resKind.STRING, value: "", comment: "", isNew: true }]),
    [readOnly]
  );

  const nameProblem = (row: Pick<Row, "name" | "isNew" | "accessor" | "problem">): string | undefined => {
    if (row.isNew) return undefined;
    if (row.name.trim() === "") return t("The name can't be empty.");
    // What the CLI found wrong with the name (the build's own rule).
    if (row.problem) return row.problem;
    if ((nameCounts.counts.get(row.name) ?? 0) > 1) return t("Another resource has the same name.");
    if (row.accessor && (nameCounts.accessors.get(row.accessor) ?? 0) > 1)
      return t("Another resource has the same accessor name ({name}).", { name: row.accessor });
    if (isCulture && neutral?.entries && !neutral.entries.some((e) => e.name === row.name))
      return t("The neutral file {file} has no resource of this name.", { file: yresFileName(set, null) });
    return undefined;
  };

  const valueIssue = (row: Row): string | undefined => {
    if (row.isNew) return undefined;
    if (isCulture && row.type !== resKind.STRING) return t("A language file holds texts only.");
    // The CLI's check — the build's own.
    return row.valueProblem;
  };

  const untranslated = (row: Row, s: Sibling) => !!s.entries && s.locale !== null && row.type === resKind.STRING && !s.texts.get(row.name);

  const errors = rows.reduce((n, r) => n + (nameProblem(r) || valueIssue(r) ? 1 : 0), 0);
  const missing = showAll
    ? entries.reduce((n, e, index) => n + siblings.filter((s) => untranslated({ id: "", index, name: e.name, type: e.type, value: e.value, comment: "" }, s)).length, 0)
    : 0;

  return { nameCounts, rows, newRow, nameProblem, valueIssue, untranslated, errors, missing };
}

/** What `useYresRows` gives the component. */
export type YresRows = ReturnType<typeof useYresRows>;
