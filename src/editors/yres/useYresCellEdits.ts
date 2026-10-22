// Edits to one cell, renames carried into the set's other files.

import type { EditorProps } from "substrate-platform-ui";
import { resKind } from "../../data/yogIds.generated";
import { coerceValue, RESOURCE_TYPES, type ResourceType, type YresEntry } from "../../lang/yres";
import type { YresFile } from "./useYresFile";
import type { YresRows } from "./useYresRows";
import type { YresSiblings } from "./useYresSiblings";
import { columnOf, CULTURE_COLUMN, type Row, COLUMN } from "./yresModel";

/** Edits to one cell, renames carried into the set's other files. */
export function useYresCellEdits(props: EditorProps, yresFile: YresFile, yresSiblings: YresSiblings, yresRows: YresRows) {
  const { readOnly } = props;
  const { entries, isCulture, showAll, siblings, apply } = yresFile;
  const { writeSibling, editableSibling } = yresSiblings;
  const { nameCounts } = yresRows;
  // ── Edits ────────────────────────────────────────────────────────────────

  function renameInSiblings(from: string, to: string) {
    for (const s of siblings) {
      if (!s.entries || s.locale === null || !s.entries.some((e) => e.name === from) || s.entries.some((e) => e.name === to)) continue;
      void writeSibling(
        s,
        s.entries.map((e) => (e.name === from ? { ...e, name: to } : e))
      );
    }
  }

  function commitCell(row: Row, column: string, text: string) {
    if (readOnly) return;
    if (column.startsWith(CULTURE_COLUMN)) {
      const sibling = siblings.find((s) => columnOf(s.locale) === column);
      if (!sibling?.entries || !editableSibling(sibling) || row.isNew || row.type !== resKind.STRING) return;
      if ((sibling.texts.get(row.name) ?? "") === text) return;
      const has = sibling.entries.some((e) => e.name === row.name);
      void writeSibling(
        sibling,
        has
          ? sibling.entries.map((e) => (e.name === row.name ? { ...e, value: text } : e))
          : [...sibling.entries, { name: row.name, type: resKind.STRING, value: text }]
      );
      return;
    }
    if (row.isNew) {
      if (text === "") return;
      const created: YresEntry = { name: "", type: resKind.STRING, value: "" };
      if (column === COLUMN.name) created.name = text.trim();
      else if (column === COLUMN.value) created.value = text;
      else if (column === COLUMN.comment) created.comment = text;
      else if (column === COLUMN.type && (RESOURCE_TYPES as readonly string[]).includes(text)) {
        created.type = text as ResourceType;
        created.value = coerceValue(created.type, "");
      } else return;
      apply([...entries, created]);
      return;
    }
    const entry = entries[row.index];
    if (!entry) return;
    let next: YresEntry;
    if (column === COLUMN.name) {
      const name = text.trim();
      if (name === entry.name) return;
      next = { ...entry, name };
      if (showAll && !isCulture && name !== "" && !nameCounts.counts.has(name)) renameInSiblings(entry.name, name);
    } else if (column === COLUMN.value) {
      const value = entry.type === resKind.NUMBER || entry.type === resKind.BOOL ? coerceValue(entry.type, text) : text;
      if (value === entry.value) return;
      next = { ...entry, value };
    } else if (column === COLUMN.type) {
      if (!(RESOURCE_TYPES as readonly string[]).includes(text) || text === entry.type) return;
      const type = text as ResourceType;
      next = { ...entry, type, value: coerceValue(type, entry.value) };
      if (type !== resKind.STRING) delete next.key;
    } else if (column === COLUMN.comment) {
      if (text === (entry.comment ?? "")) return;
      next = { ...entry, comment: text };
      if (!text) delete next.comment;
    } else return;
    apply(entries.map((e, i) => (i === row.index ? next : e)));
  }

  /** The rows Delete/Copy act on: the selection, else the row with keyboard focus. */

  return { renameInSiblings, commitCell };
}

/** What `useYresCellEdits` gives the component. */
export type YresCellEdits = ReturnType<typeof useYresCellEdits>;
