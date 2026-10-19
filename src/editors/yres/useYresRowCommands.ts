// Delete, copy and paste of whole rows.

import type { EditorProps } from "substrate-platform-ui";
import { resKind } from "../../data/yogIds.generated";
import { coerceValue, RESOURCE_TYPES, type ResourceType, type YresEntry } from "../../lang/yres";
import type { YresCellEdits } from "./useYresCellEdits";
import type { YresFile } from "./useYresFile";
import type { YresRows } from "./useYresRows";
import type { YresSiblings } from "./useYresSiblings";
import { escapeCell, type Row, unescapeCell } from "./yresModel";

/** Delete, copy and paste of whole rows. */
export function useYresRowCommands(props: EditorProps, yresFile: YresFile, yresSiblings: YresSiblings, yresRows: YresRows, yresCellEdits: YresCellEdits) {
  const { readOnly } = props;
  const { entries, isCulture, showAll, selected, setSelected, siblings, activeRef, apply } = yresFile;
  const { writeSibling } = yresSiblings;
  const { rows } = yresRows;
  const { commitCell } = yresCellEdits;
  function targetRows(): Row[] {
    const picked = rows.filter((r) => selected.has(r.id));
    if (picked.length > 0) return picked;
    const active = activeRef.current.row;
    return active && !active.isNew ? [active] : [];
  }

  function deleteRows() {
    const doomed = targetRows();
    if (readOnly || doomed.length === 0) return;
    const drop = new Set(doomed.map((r) => r.index));
    const remaining = entries.filter((_, i) => !drop.has(i));
    apply(remaining);
    if (showAll && !isCulture) {
      // As in VS's multi-language view: a resource removed goes from every language.
      const gone = new Set(doomed.map((r) => r.name).filter((name) => !remaining.some((e) => e.name === name)));
      for (const s of siblings) {
        if (s.locale !== null && s.entries?.some((e) => gone.has(e.name)))
          void writeSibling(
            s,
            s.entries.filter((e) => !gone.has(e.name))
          );
      }
    }
    setSelected(new Set());
  }

  function copyRows(): boolean {
    const picked = targetRows();
    if (picked.length === 0) return false;
    const text = picked.map((r) => [r.name, String(r.value), r.type, r.comment].map(escapeCell).join("\t")).join("\n");
    void navigator.clipboard.writeText(text).catch(() => {});
    return true;
  }

  async function paste() {
    if (readOnly) return;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
    // One plain value: into the active cell, as a spreadsheet does.
    if (lines.length === 1 && !lines[0].includes("\t")) {
      const { row, column } = activeRef.current;
      if (row && column) commitCell(row, column, lines[0]);
      return;
    }
    // Rows: Name, Value[, Type][, Comment] — as copied here, or two/three columns from a spreadsheet.
    const next = [...entries];
    for (const line of lines) {
      const cells = line.split("\t").map(unescapeCell);
      const name = (cells[0] ?? "").trim();
      if (!name) continue;
      const typed = (RESOURCE_TYPES as readonly string[]).includes(cells[2] ?? "");
      const type = (typed ? cells[2] : resKind.STRING) as ResourceType;
      const comment = typed ? cells[3] : cells[2];
      const at = next.findIndex((e) => e.name === name);
      const entry: YresEntry = { ...(at >= 0 ? next[at] : {}), name, type, value: coerceValue(type, cells[1] ?? "") };
      if (comment) entry.comment = comment;
      if (at >= 0) next[at] = entry;
      else next.push(entry);
    }
    apply(next);
  }

  return { targetRows, deleteRows, copyRows, paste };
}

/** What `useYresRowCommands` gives the component. */
export type YresRowCommands = ReturnType<typeof useYresRowCommands>;
