import { useCallback, useMemo, useRef, type ComponentType } from "react";
import { useT, type EditorProps } from "substrate-platform-ui";
import { clone } from "../../content/model";
import { DataEditor } from "../DataEditor";
import { AdvancementDesigner } from "./AdvancementDesigner";
import { EffectDesigner } from "./EffectDesigner";
import { LootDesigner } from "./LootDesigner";
import { TagDesigner } from "./TagDesigner";
import type { DefProps } from "./DefLayout";
import { parseDef, patchDef, type DefFile } from "./defModel";

export const DEF_SOURCE_VIEW = "yog.ydef.source";

/**
 * The `.ydef` kinds with a designer of their own, and their names — the one
 * list of them; a kind not here is edited as the property grid its schema
 * makes.
 */
export const DEF_DESIGNERS: Partial<Record<string, { label: string; component: ComponentType<DefProps> }>> = {
  advancement: { label: "Advancement", component: AdvancementDesigner },
  loot_table: { label: "Loot Table", component: LootDesigner },
  loot_modifier: { label: "Loot Modifier", component: LootDesigner },
  effect: { label: "Effect", component: EffectDesigner },
  tag: { label: "Tag", component: TagDesigner },
};

/** A `.ydef`: its kind's designer, else the schema's property grid. */
export function DefEditor(props: EditorProps) {
  const { path, content, onChange, readOnly } = props;
  const t = useT();
  const parsed = useMemo(() => parseDef(content), [content]);
  const contentRef = useRef(content);
  contentRef.current = content;
  const update = useCallback(
    (edit: (draft: DefFile) => void) => {
      if (readOnly || !parsed.ok) return;
      const draft = clone(parsed.file);
      edit(draft);
      const text = patchDef(contentRef.current, draft);
      if (text !== contentRef.current) onChange(text);
    },
    [onChange, readOnly, parsed],
  );
  const designer = parsed.ok && typeof parsed.file.kind === "string" ? DEF_DESIGNERS[parsed.file.kind] : undefined;
  if (!parsed.ok) return <div className="designer-error">{t("This file has a mistake: {error}", { error: parsed.error })}</div>;
  if (!designer) return <DataEditor {...props} format="ydef" sourceView={DEF_SOURCE_VIEW} />;
  const Designer = designer.component;
  return <Designer path={path} file={parsed.file} update={update} readOnly={!!readOnly} kindLabel={designer.label} />;
}
