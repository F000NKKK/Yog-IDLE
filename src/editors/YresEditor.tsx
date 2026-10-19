import {
  Button,
  DataGrid,
  type EditorProps,
  tn,
} from "substrate-platform-ui";
import "./YresEditor.css";
import { type Row } from "./yres/yresModel";
import { cellStyle } from "./yres/cellStyle";
import { YresToolbar } from "./yres/YresToolbar";
import { useYresFile } from "./yres/useYresFile";
import { useYresSiblings } from "./yres/useYresSiblings";
import { useYresRows } from "./yres/useYresRows";
import { useYresCellEdits } from "./yres/useYresCellEdits";
import { useYresRowCommands } from "./yres/useYresRowCommands";
import { useYresLanguages } from "./yres/useYresLanguages";
import { useYresKeyboard } from "./yres/useYresKeyboard";
import { useYresCells } from "./yres/useYresCells";
import { useYresColumns } from "./yres/useYresColumns";

/**
 * The `.yres` designer, like Visual Studio's ResX editor: Name | Value | Type
 * | Comment in a grid, edited in place with an editor per type (text, color,
 * image/file/sound path, number, flag), and — with "All Languages" — every
 * culture variant `<Set>.<locale>.yres` of the folder as another column of
 * texts, untranslated ones marked (VS 2022's multi-language resource view).
 * Edits of this file go through `onChange` (dirty state, Save, undo/redo);
 * edits of another language's column go to that file — its open tab if it
 * has one, straight to disk otherwise. Every edit rewrites the file
 * formatted: 2-space indent, entry order and comments kept.
 */
export function YresEditor(props: EditorProps) {
  const { readOnly } = props;
  const yresFile = useYresFile(props);
  const yresSiblings = useYresSiblings(props, yresFile);
  const yresRows = useYresRows(props, yresFile, yresSiblings);
  const yresCellEdits = useYresCellEdits(props, yresFile, yresSiblings, yresRows);
  const yresRowCommands = useYresRowCommands(props, yresFile, yresSiblings, yresRows, yresCellEdits);
  const yresLanguages = useYresLanguages(yresFile, yresSiblings);
  const yresKeyboard = useYresKeyboard(props, yresFile, yresSiblings, yresRows, yresRowCommands);
  const yresCells = useYresCells(props, yresFile, yresCellEdits, yresLanguages);
  const yresColumns = useYresColumns(props, yresFile, yresSiblings, yresCells);
  const { t, parsed, entries, isCulture, query, showAll, selected, setSelected, siblings, gridRef, rootRef, activeRef } = yresFile;
  const { shownSiblings } = yresSiblings;
  const { rows, newRow, errors, missing } = yresRows;
  const { commitCell } = yresCellEdits;
  const { viewCode } = yresKeyboard;
  const { columns } = yresColumns;
  const style = cellStyle(yresRows, shownSiblings);

  if (!parsed.ok) {
    return (
      <div className="yres-editor yres-broken">
        <p>{t("This file isn't valid .yres — line {line}: {error}", { line: parsed.line, error: parsed.error })}</p>
        <Button onClick={viewCode}>{t("View Code")}</Button>
      </div>
    );
  }

  return (
    <div className="yres-editor" ref={rootRef}>
      <YresToolbar readOnly={readOnly} file={yresFile} rowCommands={yresRowCommands} languages={yresLanguages} viewCode={viewCode} />
      <div className="yres-grid">
        <DataGrid<Row>
          className="sp-datagrid--flush"
          key={columns.map((c) => c.key).join("|")}
          handleRef={gridRef}
          columns={columns}
          rows={rows}
          pinnedRows={newRow}
          getRowId={(r) => r.id}
          selectable
          showSelectColumn={false}
          selectedIds={selected}
          onSelectionChange={setSelected}
          cellNavigation
          filterRow={false}
          showGroupPanel={false}
          persistKey={showAll || isCulture ? undefined : "yog.yres.grid"}
          onCellEditCommit={commitCell}
          onGridKeyDown={(_, row, column) => {
            activeRef.current = { row, column };
          }}
          rowClassName={(r) => (r.isNew ? "yres-newrow" : undefined)}
          cellClassName={style.cellClassName}
          cellTitle={style.cellTitle}
          emptyState={query ? t("No resources match the search.") : t("No resources yet.")}
        />
      </div>
      <div className="yres-status">
        <span>{tn(entries.length, "{count} resource", "{count} resources")}</span>
        {errors > 0 && <span className="yres-status-error">{tn(errors, "{count} error", "{count} errors")}</span>}
        {missing > 0 && <span className="yres-status-warning">{tn(missing, "{count} missing translation", "{count} missing translations")}</span>}
        {showAll && <span>{tn(siblings.length + 1, "{count} language", "{count} languages")}</span>}
      </div>
    </div>
  );
}

