import { useEffect, useMemo, useState } from "react";
import { useTyped } from "../../data/typed";
import { cli } from "../../cli";
import { useT, type PropertyDescriptor } from "substrate-platform-ui";
import { refId, refProblem, refSuggestions, useContentRefs } from "../../data/contentRefs";
import { designText, useDesignResources } from "../../lang/designResources";
import { modRootOf } from "../../paths";
import { colorText, inspectorRows, refMessage } from "../inspector";
import { RowsEditor } from "../RowsEditor";
import { asList, EFFECT_CATEGORIES, modifierText, OPERATIONS, type Operation } from "./defModel";
import { DefLayout, type DefProps } from "./DefLayout";
import { GameStage } from "./GamePanel";
import { kind as KIND, serveMethod } from "../../data/yogIds.generated";
import { idParts, GAME_NAMESPACE } from "../../data/yogFormat";

const CATEGORY_LABELS: Record<(typeof EFFECT_CATEGORIES)[number], string> = { beneficial: "Beneficial", harmful: "Harmful", neutral: "Neutral" };
const OPERATION_LABELS: Record<Operation, string> = { add: "Add", multiply_base: "Multiply Base", multiply_total: "Multiply Total" };

/** `mymod:clarity` → its translation key's text (`effect.mymod.clarity`), else its name. */
function effectName(id: string): string {
  const [ns, p] = idParts(id);
  const key = `effect.${ns}.${p.replace(/\//g, ".")}`;
  const text = designText(`@lang:${key}`);
  return text === key ? p.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : text;
}

/** An attribute's shown name: its text (`attribute.name.<ns>.<id>`), else its id's last part. */
function attributeName(ref: string): string {
  const id = refId(ref, KIND.ATTRIBUTE) ?? ref;
  const [ns, p] = idParts(id);
  const key = `attribute.name.${ns}.${p}`;
  const text = designText(`@lang:${key}`);
  return text === key ? p.split(".").pop()!.replace(/_/g, " ") : text;
}

interface Modifier extends Record<string, unknown> {
  attribute?: string;
  amount?: number;
  operation?: Operation;
}

/**
 * A mob effect as the inventory shows one: its icon and name in an effect
 * box, the color of its particles, and its modifiers as a potion's
 * tooltip lists them (+20% Grid Zoom) — blue for the good, red for the bad.
 */
export function EffectDesigner({ path, file, update, readOnly, kindLabel }: DefProps) {
  // Typed values (`@item:…`) classified by the CLI come in: draw again.
  useTyped();
  const t = useT();
  useDesignResources(modRootOf(path));
  const attributes = useContentRefs(path, KIND.ATTRIBUTE);
  const ns = attributes.own[0] ? idParts(attributes.own[0].id)[0] : GAME_NAMESPACE;
  const id = typeof file.id === "string" ? file.id : "";
  const full = id.includes(":") ? id : `${ns}:${id}`;
  const icon = useTexture(path, `${full.split(":")[0]}:mob_effect/${full.split(":")[1]}`);
  const category = EFFECT_CATEGORIES.includes(file.category as never) ? (file.category as (typeof EFFECT_CATEGORIES)[number]) : "neutral";
  const color = typeof file.color === "number" ? file.color : 0;
  const modifiers = asList<Modifier>(file.modifiers);

  const properties = useMemo<PropertyDescriptor[]>(() => {
    const { text, choice, color: colorRow } = inspectorRows(t, readOnly, path);
    const c = t("Effect");
    return [
      text("id", t("Id"), c, file.id, (v) => update((d) => void (d.id = v)), { description: t("Its id, the mod's (enlarge_grid); its icon is textures/mob_effect/<id>.png, its name effect.<ns>.<id>.") }),
      choice("category", t("Category"), c, file.category as string | undefined, EFFECT_CATEGORIES, (v) => v && update((d) => void (d.category = v)), {
        optionLabel: (o) => (o ? t(CATEGORY_LABELS[o as keyof typeof CATEGORY_LABELS]) : ""),
        description: t("Good or bad for whoever has it: its color in the inventory, what milk and beacons do with it."),
      }),
      colorRow("color", t("Color"), c, file.color as number | undefined, (v) => v !== undefined && update((d) => void (d.color = v)), { description: t("Its particles' and potions' color.") }),
      {
        id: "modifiers",
        name: "",
        category: t("Modifiers"),
        value: null,
        kind: "custom",
        description: t("Attributes it changes while it lasts, by the amount for each level."),
        render: () => (
          <RowsEditor<Modifier>
            rows={modifiers}
            readOnly={readOnly}
            blank={() => ({ attribute: "@attribute:minecraft:generic.movement_speed", amount: 0.1, operation: "multiply_total" })}
            onChange={(m) => update((d) => void (d.modifiers = m.length ? m : undefined))}
            columns={[
              { key: "attribute", label: t("Attribute"), kind: "text", grow: 3, suggestions: refSuggestions(attributes, KIND.ATTRIBUTE), validate: (v) => refMessage(t, refProblem(v, KIND.ATTRIBUTE, attributes), KIND.ATTRIBUTE) },
              { key: "amount", label: t("Amount"), kind: "number" },
              { key: "operation", label: t("Operation"), kind: "enum", grow: 2, options: OPERATIONS.map((o) => ({ value: o, label: t(OPERATION_LABELS[o]) })) },
            ]}
          />
        ),
      },
    ];
  }, [file, modifiers, attributes, readOnly, t, path, update]);

  return (
    <DefLayout path={path} kindLabel={kindLabel} properties={properties} objectName={id}>
      <GameStage width={140} height={76 + Math.max(modifiers.length, 1) * 16}>
        {(k) => (
          <>
            <div className="effect-box" style={{ left: 10 * k, top: 8 * k, width: 120 * k, height: 32 * k }}>
              {icon ? <img src={icon} alt="" className="game-icon" style={{ width: 18 * k, height: 18 * k }} /> : <span className="effect-swatch" style={{ width: 18 * k, height: 18 * k, background: colorText(color) }} />}
              <div>
                <div className="game-text-shadow" style={{ color: "#fff" }}>
                  {effectName(full)}
                </div>
                <div className="game-text-gray">0:30</div>
              </div>
              <span className="effect-dot" style={{ background: colorText(color), width: 6 * k, height: 6 * k }} title={colorText(color)} />
            </div>
            <div className="game-tooltip effect-tooltip" style={{ left: 10 * k, top: 44 * k, width: 112 * k }}>
              <div className={category === "harmful" ? "game-text-red" : "game-text-blue"}>{t(CATEGORY_LABELS[category])}</div>
              {modifiers.map((m, i) => {
                const amount = typeof m.amount === "number" ? m.amount : 0;
                const good = category === "harmful" ? amount < 0 : amount >= 0;
                return (
                  <div key={i} className={good ? "game-text-blue" : "game-text-red"}>
                    {modifierText(amount, (m.operation ?? "add") as Operation)} {attributeName(m.attribute ?? "")}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </GameStage>
    </DefLayout>
  );
}

/** A texture by id as a data URL (`null` while it isn't, or can't be, read). */
function useTexture(path: string, texture: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    cli<{ url: string }>(serveMethod.CONTENT_TEXTURE, { path, texture }).then(
      (x) => live && setUrl(x.url),
      () => live && setUrl(null),
    );
    return () => {
      live = false;
    };
  }, [path, texture]);
  return url;
}
