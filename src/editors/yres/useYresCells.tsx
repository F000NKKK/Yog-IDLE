// How a value cell shows and edits by type.

import type { EditorProps } from "substrate-platform-ui";
import { resKind } from "../../data/yogIds.generated";
import { MediaValue } from "../MediaValue";
import { CellInput, ColorEdit, ImmediateCommit } from "./cellEditors";
import type { YresCellEdits } from "./useYresCellEdits";
import type { YresFile } from "./useYresFile";
import type { YresLanguages } from "./useYresLanguages";
import { cssColor, type Row, COLUMN } from "./yresModel";

/** How a value cell shows and edits by type. */
export function useYresCells(props: EditorProps, yresFile: YresFile, yresCellEdits: YresCellEdits, yresLanguages: YresLanguages) {
  const { readOnly } = props;
  const { t } = yresFile;
  const { commitCell } = yresCellEdits;
  const { pickFile } = yresLanguages;
  // ── Cells ────────────────────────────────────────────────────────────────

  function renderValue(row: Row) {
    if (row.isNew) return null;
    const v = row.value;
    switch (row.type) {
      case resKind.COLOR:
        return (
          <span className="yres-value">
            <span className="yres-swatch" style={{ background: cssColor(row.argb) }} />
            <span className="yres-mono">{String(v)}</span>
          </span>
        );
      case resKind.IMAGE:
      case resKind.SOUND:
      case resKind.FILE:
        return <MediaValue type={row.type} value={String(v)} />;
      case resKind.BOOL:
        return (
          <input
            type="checkbox"
            className="yres-check"
            checked={v === true}
            disabled={readOnly}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onChange={(e) => commitCell(row, COLUMN.value, String(e.target.checked))}
          />
        );
      case resKind.NUMBER:
        return <span className="yres-mono">{String(v)}</span>;
      default:
        return String(v);
    }
  }

  function renderValueEdit(row: Row, commit: (value: string, move?: "down" | "next" | "prev") => void, cancel: () => void, initial?: string) {
    const value = String(row.value);
    switch (row.isNew ? resKind.STRING : row.type) {
      case resKind.BOOL:
        return <ImmediateCommit run={() => commit(String(row.value !== true))} />;
      case resKind.COLOR:
        return <ColorEdit value={value} argb={row.argb} initial={initial} commit={commit} cancel={cancel} />;
      case resKind.IMAGE:
      case resKind.FILE:
      case resKind.SOUND:
        return <CellInput value={value} initial={initial} commit={commit} cancel={cancel} browse={() => pickFile(row)} browseTitle={t("Browse…")} />;
      default:
        return <CellInput value={value} initial={initial} commit={commit} cancel={cancel} />;
    }
  }

  return { renderValue, renderValueEdit };
}

/** What `useYresCells` gives the component. */
export type YresCells = ReturnType<typeof useYresCells>;
