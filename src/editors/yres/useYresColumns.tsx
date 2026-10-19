// The grid's columns.

import { useMemo } from "react";
import { type DataGridColumn, type EditorProps } from "substrate-platform-ui";
import { resKind } from "../../data/yogIds.generated";
import { CellInput, ImmediateCommit, TypeSelect } from "./cellEditors";
import type { YresCells } from "./useYresCells";
import type { YresFile } from "./useYresFile";
import type { YresSiblings } from "./useYresSiblings";
import { columnOf, localeLabel, type Row, type Sibling, TYPE_LABELS, COLUMN } from "./yresModel";

/** The grid's columns. */
export function useYresColumns(props: EditorProps, yresFile: YresFile, yresSiblings: YresSiblings, yresCells: YresCells) {
  const { readOnly } = props;
  const { t, locale, entries, dir, ownLocale, isCulture, showAll, siblings } = yresFile;
  const { shownSiblings, editableSibling } = yresSiblings;
  const { renderValue, renderValueEdit } = yresCells;
  // ── Columns ──────────────────────────────────────────────────────────────

  const columns = useMemo<DataGridColumn<Row>[]>(() => {
    const textOf = (s: Sibling) => (r: Row) => (r.type === resKind.STRING ? (s.texts.get(r.name) ?? "") : "");
    const cultureColumns: DataGridColumn<Row>[] = shownSiblings.map((s) => ({
      key: columnOf(s.locale),
      header: `${s.locale === null ? t("Neutral") : s.locale}${s.entries ? "" : ` (${t("invalid")})`}`,
      width: 220,
      sortable: true,
      sortValue: textOf(s),
      editable: editableSibling(s),
      editValue: textOf(s),
      renderEdit: (r, commit, cancel, initial) =>
        r.isNew || r.type !== resKind.STRING ? <ImmediateCommit run={cancel} /> : <CellInput value={textOf(s)(r)} initial={initial} commit={commit} cancel={cancel} />,
      render: (r) => (r.isNew ? "" : r.type === resKind.STRING ? textOf(s)(r) : <span className="yres-na">—</span>),
    }));
    return [
      {
        key: COLUMN.name,
        header: t("Name"),
        width: 240,
        sortable: true,
        sortValue: (r) => r.name,
        editable: !readOnly,
        hideable: false,
        render: (r) => (r.isNew ? <span className="yres-placeholder">{t("Type to add a resource…")}</span> : r.name),
      },
      {
        key: COLUMN.value,
        header: showAll || shownSiblings.length > 0 ? `${t("Value")} (${localeLabel(ownLocale)})` : t("Value"),
        width: 300,
        sortable: true,
        sortValue: (r) => String(r.value),
        editable: !readOnly,
        editValue: (r) => String(r.value),
        render: renderValue,
        renderEdit: renderValueEdit,
      },
      ...(isCulture
        ? []
        : [
            {
              key: COLUMN.type,
              header: t("Type"),
              width: 100,
              sortable: true,
              sortValue: (r: Row) => r.type,
              editable: !readOnly,
              render: (r: Row) => (r.isNew ? "" : t(TYPE_LABELS[r.type])),
              renderEdit: (r: Row, commit: (value: string) => void, cancel: () => void) => <TypeSelect value={r.type} commit={commit} cancel={cancel} />,
            } satisfies DataGridColumn<Row>,
          ]),
      ...cultureColumns,
      { key: COLUMN.comment, header: t("Comment"), width: 240, sortable: true, sortValue: (r) => r.comment, editable: !readOnly },
    ];
    // Cell renderers read the latest state through closures over this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownSiblings, showAll, readOnly, ownLocale, isCulture, locale, entries, siblings, dir]);

  return { columns };
}

/** What `useYresColumns` gives the component. */
export type YresColumns = ReturnType<typeof useYresColumns>;
