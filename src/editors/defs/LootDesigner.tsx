import { useMemo, useState } from "react";
import { useT, type PropertyDescriptor } from "substrate-platform-ui";
import { refId, refProblem, refSuggestions, useContentRefs } from "../../data/contentRefs";
import { inspectorRows, refMessage } from "../inspector";
import { ItemList } from "../ItemList";
import { RowsEditor } from "../RowsEditor";
import { asList, chanceOf, chanceOfAny, countRange, expectedCount, type LootAdd } from "./defModel";
import { DefLayout, type DefProps } from "./DefLayout";
import { GameStage, ItemIcon, Slot } from "./GamePanel";

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

const ROW = 22;
const WIDTH = 196;

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const round2 = (x: number) => String(Math.round(x * 100) / 100);

/**
 * A loot table of the mod's, or a loot modifier, as a list of what it
 * gives: each item in a slot with how many, a bar of the chance it's
 * added and how many a roll gives on average (as the loader rolls it); a
 * modifier's scaled items below. The picked entry is edited in Properties;
 * a modifier's tables too.
 */
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
      const previous = asList<Record<string, unknown>>(d.add);
      d.add = rows.map((row, i) => {
        const [min, max] = [Math.max(0, Math.round(row.min)), Math.max(0, Math.round(row.max))].sort((a, b) => a - b);
        return {
          ...previous[i],
          item: row.item,
          count: min === 1 && max === 1 ? undefined : [min, max],
          chance: row.chance === 1 ? undefined : row.chance,
          function: row.function || undefined,
        };
      });
    });
  const setScaleRows = (rows: LootScaleRow[]) =>
    update((d) => {
      const previous = asList<Record<string, unknown>>(d.scale);
      d.scale = rows.map((row, i) => ({ ...previous[i], item: row.item, by: row.by }));
    });

  const properties = useMemo<PropertyDescriptor[]>(() => {
    const { text } = inspectorRows(t, readOnly, path);
    const c = t(kindLabel);
    const out: PropertyDescriptor[] = [text("id", t("Id"), c, file.id, (v) => update((d) => void (d.id = v)), { description: t("Its id, the mod's (random_scroll).") })];
    if (modifier)
      out.push({
        id: "tables",
        name: "",
        category: t("Tables"),
        value: null,
        kind: "custom",
        description: t("The loot tables it changes: chests, block drops, mobs (@loot_table:minecraft:chests/simple_dungeon)."),
        render: () => (
          <ItemList
            items={asList<string>(file.tables)}
            readOnly={readOnly}
            suggestions={refSuggestions(tables, "loot_table")}
            validate={(v) => refMessage(t, refProblem(v, "loot_table", tables), "loot_table")}
            label={(v) => refId(v, "loot_table") ?? v}
            onChange={(v) => update((d) => void (d.tables = v))}
          />
        ),
      });
    out.push({
      id: "items",
      name: "",
      category: t("Items"),
      value: null,
      kind: "custom",
      description: t("Items this table gives, with their count range, chance, and optional registered loot function."),
      render: () => (
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
      ),
    });
    if (modifier)
      out.push({
        id: "scale",
        name: "",
        category: t("Scaled"),
        value: null,
        kind: "custom",
        description: t("Items whose stack counts are multiplied after the additions."),
        render: () => (
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
        ),
      });
    return out;
  }, [file, modifier, addRows, scaleRows, items, tables, readOnly, t, path, update, kindLabel]);

  const rows = add.length + (scale.length ? scale.length + 1 : 0);
  const height = 20 + Math.max(rows, 1) * ROW + (modifier ? 10 : 0);
  const tableCount = asList(file.tables).length;
  return (
    <DefLayout
      path={path}
      kindLabel={kindLabel}
      properties={properties}
      objectName={typeof file.id === "string" ? file.id : ""}
    >
      <GameStage width={WIDTH} height={height} onBackground={() => setPicked(null)}>
        {(k) => (
          <>
            <div className="game-title" style={{ left: 7 * k, top: 5 * k }}>
              {modifier ? t("Adds to {n} tables", { n: tableCount }) : typeof file.id === "string" ? file.id : ""}
            </div>
            {add.map((e, i) => {
              const [lo, hi] = countRange(e);
              return (
                <div key={`a${i}`} className={`loot-row${pick?.list === "add" && pick.i === i ? " is-picked" : ""}`} style={{ top: (18 + i * ROW) * k, height: ROW * k }} onClick={() => setPicked({ list: "add", i })}>
                  <Slot k={k} picked={pick?.list === "add" && pick.i === i} label={hi > 1 ? (lo === hi ? lo : `${lo}–${hi}`) : undefined}>
                    <ItemIcon path={path} id={e.item} k={k} />
                  </Slot>
                  <div className="loot-text">
                    <div className="loot-name">{(refId(e.item ?? "", "item") ?? e.item ?? "").split(":").pop()}</div>
                    <div className="loot-bar" title={pct(chanceOfAny(e))}>
                      <span style={{ width: pct(chanceOfAny(e)) }} />
                    </div>
                  </div>
                  <div className="loot-odds">
                    <div>{pct(chanceOfAny(e))}</div>
                    <div className="loot-avg">≈{round2(expectedCount(e))}</div>
                  </div>
                </div>
              );
            })}
            {scale.length > 0 && (
              <div className="game-title" style={{ left: 7 * k, top: (18 + add.length * ROW + 6) * k }}>
                {t("Scaled")}
              </div>
            )}
            {scale.map((e, i) => (
              <div key={`s${i}`} className="loot-row" style={{ top: (18 + (add.length + 1) * ROW + i * ROW) * k, height: ROW * k }} onClick={() => setPicked({ list: "scale", i })}>
                <Slot k={k} picked={pick?.list === "scale" && pick.i === i}>
                  <ItemIcon path={path} id={e.item} k={k} />
                </Slot>
                <div className="loot-text">
                  <div className="loot-name">{(refId(e.item ?? "", "item") ?? e.item ?? "").split(":").pop()}</div>
                </div>
                <div className="loot-odds">×{round2(e.by ?? 1)}</div>
              </div>
            ))}
            {!add.length && !scale.length && (
              <div className="game-title" style={{ left: 7 * k, top: 22 * k }}>
                {t("Nothing yet: Add an Item.")}
              </div>
            )}
          </>
        )}
      </GameStage>
    </DefLayout>
  );
}
