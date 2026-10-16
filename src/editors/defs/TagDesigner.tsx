import { useMemo } from "react";
import { Icon, ToolbarGroup, ToolbarSelect, useT, type PropertyDescriptor } from "substrate-platform-ui";
import { refProblem, refSuggestions, useContentRefs } from "../../data/contentRefs";
import { inspectorRows, refMessage } from "../inspector";
import { ItemList } from "../ItemList";
import { asList, TAG_KINDS } from "./defModel";
import { DefLayout, type DefProps } from "./DefLayout";
import { ItemIcon } from "./GamePanel";
/** Kinds of content drawn as their item's icon. */
const ICONS = new Set(["item", "block"]);
export function TagDesigner({ path, file, update, readOnly, kindLabel }: DefProps) {
  const t = useT();
  const of = typeof file.of === "string" ? file.of : "item";
  const refs = useContentRefs(path, of);
  const tags = useContentRefs(path, `tag:${of}`);
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
    ];
  }, [file, of, readOnly, t, path, update]);

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
      <div className="tag-members-editor">
        <section className="tag-members-section">
          <header>
            <strong>{t("Members")}</strong>
            <span className="designer-info" title={t("What's in it: @<kind>:<id>, checked to exist, or a tag of the kind (@tag:<kind>:<id>).")} aria-label={t("What's in it: @<kind>:<id>, checked to exist, or a tag of the kind (@tag:<kind>:<id>).")}>
              <Icon name="info" size={14} />
            </span>
          </header>
          <ItemList
            items={values}
            readOnly={readOnly}
            suggestions={suggestions}
            validate={check}
            lead={ICONS.has(of) ? (m) => <ItemIcon path={path} id={m.startsWith("@tag:") ? undefined : m} k={1} /> : undefined}
            onChange={(v) => update((d) => void (d.values = v.length ? v : undefined))}
          />
        </section>
        <section className="tag-members-section">
          <header>
            <strong>{t("If Present")}</strong>
            <span className="designer-info" title={t("In it if it's there — another mod's content (@entity:create:seat), not checked.")} aria-label={t("In it if it's there — another mod's content (@entity:create:seat), not checked.")}>
              <Icon name="info" size={14} />
            </span>
          </header>
          <ItemList
            items={optional}
            readOnly={readOnly}
            suggestions={suggestions}
            lead={ICONS.has(of) ? (m) => <ItemIcon path={path} id={m.startsWith("@tag:") ? undefined : m} k={1} /> : undefined}
            onChange={(v) => update((d) => void (d.optional = v.length ? v : undefined))}
          />
        </section>
      </div>
    </DefLayout>
  );
}
