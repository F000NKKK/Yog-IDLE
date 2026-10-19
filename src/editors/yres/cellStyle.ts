import { t } from "substrate-platform-ui";
import { NEUTRAL_LOCALE } from "../../lang/yres";
import { resKind } from "../../data/yogIds.generated";
import type { YresRows } from "./useYresRows";
import { CELL_CLASS, COLUMN, columnOf, CULTURE_COLUMN, type Row, type Sibling } from "./yresModel";

/** How the grid marks a cell — invalid or missing — and what its tooltip says why. */
export function cellStyle({ nameProblem, valueIssue, untranslated }: YresRows, shownSiblings: readonly Sibling[]) {
  const siblingOf = (column: string) => (column.startsWith(CULTURE_COLUMN) ? shownSiblings.find((x) => columnOf(x.locale) === column) : undefined);
  return {
    cellClassName(r: Row, column: string): string | undefined {
      if (column === COLUMN.name) return nameProblem(r) ? CELL_CLASS.invalid : undefined;
      if (r.isNew) return undefined;
      if (column === COLUMN.value) return valueIssue(r) ? CELL_CLASS.invalid : r.type === resKind.STRING && r.value === "" ? CELL_CLASS.missing : undefined;
      const s = siblingOf(column);
      return s && untranslated(r, s) ? CELL_CLASS.missing : undefined;
    },
    cellTitle(r: Row, column: string): string | undefined {
      if (column === COLUMN.name) return nameProblem(r);
      if (column === COLUMN.value) return valueIssue(r);
      const s = siblingOf(column);
      if (s && !r.isNew && untranslated(r, s)) return t("Not translated — the game shows the {locale} text.", { locale: NEUTRAL_LOCALE });
      return undefined;
    },
  };
}
