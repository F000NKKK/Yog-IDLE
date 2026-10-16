import { useMemo, useState } from "react";
import { ToolbarGroup, ToolbarSelect, useT, type PropertyDescriptor } from "substrate-platform-ui";
import { refProblem, refSuggestions, useContentRefs } from "../../data/contentRefs";
import { classify } from "../../data/yogData";
import { inspectorRows, refMessage } from "../inspector";
import { ItemList } from "../ItemList";
import { asList, TAG_KINDS } from "./defModel";
import { DefLayout, type DefProps } from "./DefLayout";
import { GameStage, ItemIcon, Slot } from "./GamePanel";

/** Members a row of the panel, as the game's inventories. */
const COLUMNS = 9;
/** Kinds of content drawn as their item's icon. */
const ICONS = new Set(["item", "block"]);

/** A member as the panel labels it: its id's last part, `#` before a tag's. */
function memberLabel(m: string): string {
  try {
    const v = classify(m);
    if (v.t === "tag") return `#${v.id.split(/[:/]/).pop()}`;
    if (v.t === "ref") return v.id.split(/[:/]/).pop() ?? v.id;
  } catch {
    /* shown as written */
  }
  return m;
}

/**
 * A tag as an inventory of what's in it: its members in slots (the ones
 * only there if another mod is, dimmed), a member picked from what the
 * mod, its declared mods and the game have of the tag's kind — or another
 * tag of that kind.
 */
export function TagDesigner({ path, file, update, readOnly, kindLabel }: DefProps) {
  const t = useT();
  const of = typeof file.of === "string" ? file.of : "item";
  const refs = useContentRefs(path, of);
  const tags = useContentRefs(path, `tag:${of}`);
  const [picked, setPicked] = useState<{ list: "values" | "optional"; i: number } | null>(null);
  const values = asList<string>(file.values);
  const optional = asList<string>(file.optional);
  const suggestions = useMemo(() => [...refSuggestions(refs, of), ...refSuggestions(tags, of).map((s) => s.replace(`@${of}:`, `@tag:${of}:`))], [refs, tags, of]);
  const check = (m: string) => {
    const p = refProblem(m, of, refs, true);
    if (p || !m.startsWith("@tag:")) return refMessage(t, p, of);
    return refMessage(t, refProblem(m.replace(`@tag:${of}:`, `@${of}:`), of, tags), `tag:${of}`);
  };

  const properties = useMemo<PropertyDescriptor[]>(() => {
    const { text, choice } = inspectorRows(t, readOnly, path);
    const c = t("Tag");
    return [
      text("id", t("Id"), c, file.id, (v) => update((d) => void (d.id = v)), { description: t("water_plants (the mod's) — or another's to add to (minecraft:logs).") }),
      choice("of", t("Of"), c, of, TAG_KINDS.includes(of as never) ? TAG_KINDS : [...TAG_KINDS, of], (v) => update((d) => void (d.of = v)), {
        description: t("The kind of content: item, block, entity, fluid, biome, damage_type — or any of the game's registries by its name."),
      }),
      {
        id: "values",
        name: t("Members"),
        category: t("Members"),
        value: null,
        kind: "custom",
        description: t("What's in it: @<kind>:<id>, checked to exist, or a tag of the kind (@tag:<kind>:<id>)."),
        render: () => (
          <ItemList
            items={values}
            readOnly={readOnly}
            suggestions={suggestions}
            validate={check}
            lead={ICONS.has(of) ? (m) => <ItemIcon path={path} id={m} k={1} /> : undefined}
            picked={picked?.list === "values" ? picked.i : null}
            onPick={(i) => setPicked({ list: "values", i })}
            onChange={(v) => update((d) => void (d.values = v.length ? v : undefined))}
          />
        ),
      },
      {
        id: "optional",
        name: t("If Present"),
        category: t("If Present"),
        value: null,
        kind: "custom",
        description: t("In it if it's there — another mod's content (@entity:create:seat), not checked."),
        render: () => (
          <ItemList
            items={optional}
            readOnly={readOnly}
            suggestions={suggestions}
            lead={ICONS.has(of) ? (m) => <ItemIcon path={path} id={m} k={1} /> : undefined}
            picked={picked?.list === "optional" ? picked.i : null}
            onPick={(i) => setPicked({ list: "optional", i })}
            onChange={(v) => update((d) => void (d.optional = v.length ? v : undefined))}
          />
        ),
      },
    ];
  }, [file, of, values, optional, suggestions, picked, readOnly, t, path, update]);

  const members = [...values.map((m, i) => ({ m, list: "values" as const, i })), ...optional.map((m, i) => ({ m, list: "optional" as const, i }))];
  const rows = Math.max(1, Math.ceil(members.length / COLUMNS));
  const id = typeof file.id === "string" ? file.id : "";
  return (
    <DefLayout
      path={path}
      kindLabel={kindLabel}
      properties={properties}
      objectName={`#${id}`}
      tools={
        <ToolbarGroup>
          <ToolbarSelect
            label={t("Of")}
            value={of}
            disabled={readOnly}
            options={(TAG_KINDS.includes(of as never) ? TAG_KINDS : [...TAG_KINDS, of]).map((k) => ({ value: k, label: k }))}
            onChange={(v) => update((d) => void (d.of = v))}
          />
        </ToolbarGroup>
      }
    >
      <GameStage width={COLUMNS * 18 + 14} height={rows * 18 + 26} onBackground={() => setPicked(null)}>
        {(k) => (
          <>
            <div className="game-title" style={{ left: 7 * k, top: 5 * k }}>
              #{id} <span className="game-text-gray">({of})</span>
            </div>
            <div className="tag-grid" style={{ left: 7 * k, top: 17 * k, gridTemplateColumns: `repeat(${COLUMNS}, ${18 * k}px)` }}>
              {members.map(({ m, list, i }) => (
                <Slot key={`${list}${i}`} k={k} picked={picked?.list === list && picked.i === i} onPick={() => setPicked({ list, i })} style={list === "optional" ? { opacity: 0.55 } : undefined} label={m.startsWith("@tag:") ? "#" : undefined}>
                  {ICONS.has(of) ? <ItemIcon path={path} id={m.startsWith("@tag:") ? undefined : m} k={k} title={m} /> : <span className="tag-text" title={m}>{memberLabel(m)}</span>}
                </Slot>
              ))}
              {Array.from({ length: rows * COLUMNS - members.length }, (_, i) => (
                <Slot key={`e${i}`} k={k} />
              ))}
            </div>
          </>
        )}
      </GameStage>
    </DefLayout>
  );
}
