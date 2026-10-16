import { useMemo } from "react";
import { useT, type PropertyDescriptor } from "substrate-platform-ui";
import { refId, refProblem, refSuggestions, useContentRefs } from "../../data/contentRefs";
import { inspectorRows, refMessage } from "../inspector";
import { ItemList } from "../ItemList";
import { RowsEditor } from "../RowsEditor";
import { asList, chanceOf, countRange, type LootAdd } from "./defModel";
import { DefLayout, type DefProps } from "./DefLayout";

interface LootScale {
  item?: string;
  by?: number;
}

interface LootAddRow extends Record<string, unknown> {
  item?: string;
  min: number;
  max: number;
  chance: number;
  function?: string;
}

interface LootScaleRow extends Record<string, unknown> {
  item?: string;
  by: number;
}

/** A loot table or modifier, edited in full-width rows rather than a mock preview. */
export function LootDesigner({ path, file, update, readOnly, kindLabel }: DefProps) {
  const t = useT();
  const modifier = file.kind === "loot_modifier";
  const items = useContentRefs(path, "item");
  const tables = useContentRefs(path, "loot_table");
  const add = asList<LootAdd>(file.add);
  const scale = modifier ? asList<LootScale>(file.scale) : [];
  const addRows: LootAddRow[] = add.map((entry) => {
    const [min, max] = countRange(entry);
    return { ...entry, min, max, chance: chanceOf(entry) };
  });
  const scaleRows: LootScaleRow[] = scale.map((entry) => ({ ...entry, by: entry.by ?? 0.5 }));

  const setAddRows = (rows: LootAddRow[]) =>
    update((d) => {
      d.add = rows.map((row, i) => {
        const [min, max] = [Math.max(0, Math.round(row.min)), Math.max(0, Math.round(row.max))].sort((a, b) => a - b);
        const { min: _min, max: _max, chance, function: lootFunction, item, ...rest } = row;
        return {
          ...rest,
          item,
          count: min === 1 && max === 1 ? undefined : [min, max],
          chance: chance === 1 ? undefined : chance,
          function: lootFunction || undefined,
        };
      });
    });
  const setScaleRows = (rows: LootScaleRow[]) =>
    update((d) => {
      d.scale = rows.map(({ item, by, ...rest }) => ({ ...rest, item, by }));
    });

  const properties = useMemo<PropertyDescriptor[]>(() => {
    const { text } = inspectorRows(t, readOnly, path);
    const c = t(kindLabel);
    return [text("id", t("Id"), c, file.id, (v) => update((d) => void (d.id = v)), { description: t("Its id, the mod's (random_scroll).") })];
  }, [file, modifier, addRows, scaleRows, items, tables, readOnly, t, path, update, kindLabel]);

  return (
    <DefLayout
      path={path}
      kindLabel={kindLabel}
      properties={properties}
      objectName={typeof file.id === "string" ? file.id : ""}
    >
      <div className="loot-editor">
        {modifier && (
          <section className="loot-editor-section">
            <header>
              <strong>{t("Tables")}</strong>
              <span>{t("The loot tables it changes: chests, block drops, mobs (@loot_table:minecraft:chests/simple_dungeon).")}</span>
            </header>
            <ItemList
              items={asList<string>(file.tables)}
              readOnly={readOnly}
              suggestions={refSuggestions(tables, "loot_table")}
              validate={(v) => refMessage(t, refProblem(v, "loot_table", tables), "loot_table")}
              label={(v) => refId(v, "loot_table") ?? v}
              onChange={(v) => update((d) => void (d.tables = v))}
            />
          </section>
        )}
        <section className="loot-editor-section">
          <header>
            <strong>{t("Items")}</strong>
            <span>{t("Items this table gives, with their count range, chance, and optional registered loot function.")}</span>
          </header>
          <RowsEditor<LootAddRow>
            rows={addRows}
            readOnly={readOnly}
            blank={() => ({ item: "@item:minecraft:stick", min: 1, max: 1, chance: 1 })}
            onChange={setAddRows}
            columns={[
              { key: "item", label: t("Item"), kind: "text", grow: 3, suggestions: refSuggestions(items, "item"), validate: (v) => refMessage(t, refProblem(v, "item", items), "item") },
              { key: "min", label: t("Min"), kind: "number", min: 0, int: true },
              { key: "max", label: t("Max"), kind: "number", min: 0, int: true },
              { key: "chance", label: t("Chance"), kind: "number", min: 0, max: 1 },
              { key: "function", label: t("Loot Function"), kind: "text" },
            ]}
          />
        </section>
        {modifier && (
          <section className="loot-editor-section">
            <header>
              <strong>{t("Scaled")}</strong>
              <span>{t("Items whose stack counts are multiplied after the additions.")}</span>
            </header>
            <RowsEditor<LootScaleRow>
              rows={scaleRows}
              readOnly={readOnly}
              blank={() => ({ item: "@item:minecraft:stick", by: 0.5 })}
              onChange={setScaleRows}
              columns={[
                { key: "item", label: t("Item"), kind: "text", grow: 3, suggestions: refSuggestions(items, "item"), validate: (v) => refMessage(t, refProblem(v, "item", items), "item") },
                { key: "by", label: t("Factor"), kind: "number", min: 0, max: 64 },
              ]}
            />
          </section>
        )}
      </div>
    </DefLayout>
  );
}
