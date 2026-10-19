import { SearchField, Spacer, Toolbar, ToolbarButton, ToolbarGroup } from "substrate-platform-ui";
import type { YresFile } from "./useYresFile";
import type { YresLanguages } from "./useYresLanguages";
import type { YresRowCommands } from "./useYresRowCommands";
import { COLUMN, NEW_ROW_ID } from "./yresModel";

/** The `.yres` designer's toolbar: add/remove rows, languages, search, View Code. */
export function YresToolbar({ readOnly, file, rowCommands, languages, viewCode }: { readOnly?: boolean; file: YresFile; rowCommands: YresRowCommands; languages: YresLanguages; viewCode: () => void }) {
  const { t, gridRef, showAll, query, setQuery } = file;
  return (
    <Toolbar>
      <ToolbarGroup>
        <ToolbarButton icon="plus" label="Add Resource" disabled={readOnly} onClick={() => gridRef.current?.editCell(NEW_ROW_ID, COLUMN.name)} />
        <ToolbarButton icon="trash" label="Remove Resource" disabled={readOnly || rowCommands.targetRows().length === 0} onClick={rowCommands.deleteRows} />
      </ToolbarGroup>
      <ToolbarGroup>
        <ToolbarButton label="All Languages" tooltip="Show every language of this resource set as a column" active={showAll} onClick={languages.toggleShowAll} />
        <ToolbarButton icon="plus" label="Language…" showLabel disabled={readOnly} onClick={() => void languages.addLanguage()} />
      </ToolbarGroup>
      <Spacer />
      <SearchField className="yres-search" value={query} onValueChange={setQuery} placeholder={t("Search resources")} />
      <ToolbarButton icon="code" label="View Code" shortcut="f7" onClick={viewCode} />
    </Toolbar>
  );
}
