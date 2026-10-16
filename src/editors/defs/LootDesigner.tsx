import { useMemo, useState } from "react";
import { ToolbarButton, ToolbarGroup, useT, type PropertyDescriptor } from "substrate-platform-ui";
import { refId, refProblem, refSuggestions, useContentRefs } from "../../data/contentRefs";
import { inspectorRows, refMessage } from "../inspector";
import { ItemList } from "../ItemList";
import { asList, chanceOf, chanceOfAny, countRange, expectedCount, type LootAdd } from "./defModel";
import { DefLayout, type DefProps } from "./DefLayout";
import { GameStage, ItemIcon, Slot } from "./GamePanel";

interface LootScale {
  item?: string;
  by?: number;
}

type Pick = { list: "add" | "scale"; i: number } | null;

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
  const [picked, setPicked] = useState<Pick>(null);
  const add = asList<LootAdd>(file.add);
  const scale = modifier ? asList<LootScale>(file.scale) : [];
  const pick = picked && (picked.list === "add" ? picked.i < add.length : picked.i < scale.length) ? picked : null;

  const setEntry = (list: "add" | "scale", i: number, change: (e: Record<string, unknown>) => void) =>
    update((d) => {
      const l = asList<Record<string, unknown>>(d[list]).map((e) => ({ ...e }));
      if (!l[i]) return;
      change(l[i]);
      d[list] = l;
    });
  const newEntry = (list: "add" | "scale") => {
    const blank = list === "add" ? { item: "@item:minecraft:stick" } : { item: "@item:minecraft:stick", by: 0.5 };
    update((d) => void (d[list] = [...asList(d[list]), blank]));
    setPicked({ list, i: (list === "add" ? add : scale).length });
  };
  const removePicked = () => {
    if (!pick) return;
    update((d) => {
      const l = asList(d[pick.list]).filter((_, j) => j !== pick.i);
      d[pick.list] = l.length || pick.list === "add" ? l : undefined;
    });
    setPicked(null);
  };

  const properties = useMemo<PropertyDescriptor[]>(() => {
    const { text, num, ref } = inspectorRows(t, readOnly, path);
    const c = t(kindLabel);
    const out: PropertyDescriptor[] = [text("id", t("Id"), c, file.id, (v) => update((d) => void (d.id = v)), { description: t("Its id, the mod's (random_scroll).") })];
    if (modifier)
      out.push({
        id: "tables",
        name: t("Tables"),
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
    if (pick?.list === "add") {
      const e = add[pick.i];
      const ec = t("Item Added");
      const [lo, hi] = countRange(e);
      out.push(
        ref("add.item", t("Item"), ec, e.item, "item", items, (v) => v && setEntry("add", pick.i, (x) => void (x.item = v))),
        {
          id: "add.count",
          name: t("Count"),
          category: ec,
          value: [lo, hi],
          labels: [t("Min"), t("Max")],
          readOnly,
          description: t("How many: from the first to the second, evenly; below 1 adds none."),
          onCommit: (v) => {
            const [a, b] = (v as number[]).map((n) => Math.round(n));
            setEntry("add", pick.i, (x) => void (x.count = a === 1 && b === 1 ? undefined : [a, b]));
          },
        },
        num("add.chance", t("Chance"), ec, e.chance, (v) => setEntry("add", pick.i, (x) => void (x.chance = v === 1 ? undefined : v)), {
          min: 0,
          max: 1,
          displayValue: `${pct(chanceOf(e))}${e.chance === undefined ? ` ${t("(default)")}` : ""}`,
          description: t("The chance it's added at all, 0–1."),
        }),
        text("add.function", t("Loot Function"), ec, e.function, (v) => setEntry("add", pick.i, (x) => void (x.function = v)), {
          description: t("A loot function of the mod's code that finishes the stack (its custom data), by the name it's registered under."),
        }),
      );
    } else if (pick?.list === "scale") {
      const e = scale[pick.i];
      const sc = t("Item Scaled");
      out.push(
        ref("scale.item", t("Item"), sc, e.item, "item", items, (v) => v && setEntry("scale", pick.i, (x) => void (x.item = v))),
        num("scale.by", t("Factor"), sc, e.by, (v) => v !== undefined && setEntry("scale", pick.i, (x) => void (x.by = v)), { min: 0, max: 64, description: t("Its count times this, rounded down (0.5: half, at least none).") }),
      );
    }
    return out;
  }, [file, modifier, add, scale, pick, items, tables, readOnly, t, path, update, kindLabel]);

  const rows = add.length + (scale.length ? scale.length + 1 : 0);
  const height = 20 + Math.max(rows, 1) * ROW + (modifier ? 10 : 0);
  const tableCount = asList(file.tables).length;
  return (
    <DefLayout
      path={path}
      kindLabel={kindLabel}
      properties={properties}
      objectName={typeof file.id === "string" ? file.id : ""}
      objectKey={pick ? `${path}#${pick.list}${pick.i}` : path}
      tools={
        !readOnly && (
          <ToolbarGroup>
            <ToolbarButton icon="plus" label="Add an Item" showLabel onClick={() => newEntry("add")} />
            {modifier && <ToolbarButton icon="plus" label="Scale an Item" showLabel onClick={() => newEntry("scale")} />}
            <ToolbarButton icon="trash" label="Remove" disabled={!pick} onClick={removePicked} />
          </ToolbarGroup>
        )
      }
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
