import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT, type PropertyDescriptor } from "substrate-platform-ui";
import { refId, refProblem, refSuggestions, useContentDefs, useContentRefs } from "../../data/contentRefs";
import { designText, useDesignResources } from "../../lang/designResources";
import { modRootOf } from "../../paths";
import { NO_TINT, TintedItem } from "../../designer/TintedItem";
import { colorText, inspectorRows, refMessage } from "../inspector";
import { RowsEditor } from "../RowsEditor";
import { asList, EFFECT_CATEGORIES, levelText, mixColors, modifierText, OPERATIONS, ticksText, type Operation } from "./defModel";
import { DefLayout, type DefProps } from "./DefLayout";
import { GameStage, ItemIcon, Slot } from "./GamePanel";

const CATEGORY_LABELS: Record<(typeof EFFECT_CATEGORIES)[number], string> = { beneficial: "Beneficial", harmful: "Harmful", neutral: "Neutral" };
const OPERATION_LABELS: Record<Operation, string> = { add: "Add", multiply_base: "Multiply Base", multiply_total: "Multiply Total" };

/** The game's potion bottles: the liquid (tinted) under the glass, as its potion items' layers. */
const BOTTLES = [
  ["minecraft:item/potion_overlay", "minecraft:item/potion"],
  ["minecraft:item/potion_overlay", "minecraft:item/splash_potion"],
  ["minecraft:item/potion_overlay", "minecraft:item/lingering_potion"],
] as const;
/** A potion's colour with no effect the designer knows the colour of: the game's water. */
const WATER = 0x385dc6;

/** `mymod:clarity` → its translation key's text (`effect.mymod.clarity`), else its name. */
function effectName(id: string): string {
  const [ns, p] = id.includes(":") ? id.split(":") : ["minecraft", id];
  const key = `effect.${ns}.${p.replace(/\//g, ".")}`;
  const text = designText(`@lang:${key}`);
  return text === key ? p.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : text;
}

/** An attribute's shown name: its text (`attribute.name.<ns>.<id>`), else its id's last part. */
function attributeName(ref: string): string {
  const id = refId(ref, "attribute") ?? ref;
  const [ns, p] = id.includes(":") ? id.split(":") : ["minecraft", id];
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
 * box, the colour of its particles, and its modifiers as a potion's
 * tooltip lists them (+20% Grid Zoom) — blue for the good, red for the bad.
 */
export function EffectDesigner({ path, file, update, readOnly, kindLabel }: DefProps) {
  const t = useT();
  useDesignResources(modRootOf(path));
  const attributes = useContentRefs(path, "attribute");
  const ns = attributes.own[0]?.id.split(":")[0] ?? "minecraft";
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
        description: t("Good or bad for whoever has it: its colour in the inventory, what milk and beacons do with it."),
      }),
      colorRow("color", t("Colour"), c, file.color as number | undefined, (v) => v !== undefined && update((d) => void (d.color = v)), { description: t("Its particles' and potions' colour.") }),
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
              { key: "attribute", label: t("Attribute"), kind: "text", grow: 3, suggestions: refSuggestions(attributes, "attribute"), validate: (v) => refMessage(t, refProblem(v, "attribute", attributes), "attribute") },
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
      <GameStage width={140} height={52 + Math.max(modifiers.length, 1) * 10}>
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

interface PotionEffect extends Record<string, unknown> {
  effect?: string;
  duration?: number;
  amplifier?: number;
}

interface Brew extends Record<string, unknown> {
  from?: string;
  with?: string;
}

/**
 * A potion as the game shows it: its bottles (drunk, splash, lingering) in
 * the colour its effects mix to, a tooltip of its effects with level and
 * time, and each brewing that makes it — the potion brewed from and the
 * ingredient, then this one.
 */
export function PotionDesigner({ path, file, update, readOnly, kindLabel }: DefProps) {
  const t = useT();
  useDesignResources(modRootOf(path));
  const effects = useContentRefs(path, "effect");
  const potions = useContentRefs(path, "potion");
  const items = useContentRefs(path, "item");
  const ownEffects = useContentDefs(path, "effect");
  const list = asList<PotionEffect>(file.effects);
  const brews = asList<Brew>(file.brewed);
  const info = (ref: string) => {
    const id = refId(ref, "effect");
    const d = ownEffects.find((e) => e.id === id)?.value;
    return { id: id ?? ref, color: typeof d?.color === "number" ? d.color : null, harmful: d?.category === "harmful" };
  };
  const known = list.map((e) => ({ ...info(e.effect ?? ""), amplifier: e.amplifier ?? 0 })).filter((e) => e.color !== null) as { color: number; amplifier: number }[];
  const color = mixColors(known) ?? WATER;

  const properties = useMemo<PropertyDescriptor[]>(() => {
    const { text } = inspectorRows(t, readOnly, path);
    const c = t("Potion");
    return [
      text("id", t("Id"), c, file.id, (v) => update((d) => void (d.id = v)), { description: t("Its id, the mod's (enlarge_grid_long).") }),
      text("name", t("Name"), c, file.name as string | undefined, (v) => update((d) => void (d.name = v)), {
        description: t("The name its translations go by (item.minecraft.potion.effect.<name>): its id's by default — a longer or stronger kind shares the plain one's."),
      }),
      {
        id: "effects",
        name: "",
        category: t("Effects"),
        value: null,
        kind: "custom",
        description: t("What it gives: an effect, for how many ticks (20 a second), at which level (0 is I)."),
        render: () => (
          <RowsEditor<PotionEffect>
            rows={list}
            readOnly={readOnly}
            blank={() => ({ effect: "@effect:minecraft:speed", duration: 3600, amplifier: 0 })}
            onChange={(v) => update((d) => void (d.effects = v))}
            trail={(e) => ticksText(e.duration ?? 0)}
            columns={[
              { key: "effect", label: t("Type"), kind: "text", grow: 3, suggestions: refSuggestions(effects, "effect"), validate: (v) => refMessage(t, refProblem(v, "effect", effects), "effect") },
              { key: "duration", label: t("Ticks"), kind: "number", min: 1, int: true },
              { key: "amplifier", label: t("Level"), kind: "number", min: 0, int: true, placeholder: "0" },
            ]}
          />
        ),
      },
      {
        id: "brewed",
        name: "",
        category: t("Brewing"),
        value: null,
        kind: "custom",
        description: t("Brewing stand recipes making it: the potion brewed from, and the ingredient."),
        render: () => (
          <RowsEditor<Brew>
            rows={brews}
            readOnly={readOnly}
            blank={() => ({ from: "@potion:minecraft:awkward", with: "@item:minecraft:redstone" })}
            onChange={(v) => update((d) => void (d.brewed = v.length ? v : undefined))}
            lead={(b) => <ItemIcon path={path} id={b.with} k={1} />}
            columns={[
              { key: "from", label: t("From"), kind: "text", grow: 2, suggestions: refSuggestions(potions, "potion"), validate: (v) => refMessage(t, refProblem(v, "potion", potions), "potion") },
              { key: "with", label: t("Ingredient"), kind: "text", grow: 2, suggestions: refSuggestions(items, "item"), validate: (v) => refMessage(t, refProblem(v, "item", items), "item") },
            ]}
          />
        ),
      },
    ];
  }, [file, list, brews, effects, potions, items, readOnly, t, path, update]);

  const height = 34 + Math.max(list.length, 1) * 10 + 8 + brews.length * 22;
  return (
    <DefLayout path={path} kindLabel={kindLabel} properties={properties} objectName={typeof file.id === "string" ? file.id : ""}>
      <GameStage width={176} height={height}>
        {(k) => (
          <>
            <div className="potion-bottles" style={{ left: 8 * k, top: 6 * k, gap: 4 * k }}>
              {BOTTLES.map((layers) => (
                <Slot key={layers[1]} k={k}>
                  <TintedItem path={path} layers={layers} colors={[color, NO_TINT]} size={16 * k} />
                </Slot>
              ))}
            </div>
            <div className="game-tooltip potion-tooltip" style={{ left: 8 * k, top: 28 * k }}>
              {list.map((e, i) => {
                const f = info(e.effect ?? "");
                const level = (e.amplifier ?? 0) > 0 ? ` ${levelText(e.amplifier ?? 0)}` : "";
                return (
                  <div key={i} className={f.harmful ? "game-text-red" : "game-text-blue"}>
                    {effectName(f.id)}
                    {level} ({ticksText(e.duration ?? 0)})
                  </div>
                );
              })}
              {!list.length && <div className="game-text-gray">{t("No effects")}</div>}
            </div>
            {brews.map((b, i) => (
              <div key={i} className="potion-brew" style={{ left: 8 * k, top: (34 + Math.max(list.length, 1) * 10 + 8 + i * 22) * k, gap: 4 * k }}>
                <Slot k={k} label={(refId(b.from ?? "", "potion") ?? "").split(":").pop()}>
                  <TintedItem path={path} layers={BOTTLES[0]} colors={[WATER, NO_TINT]} size={16 * k} />
                </Slot>
                <span>+</span>
                <Slot k={k}>
                  <ItemIcon path={path} id={b.with} k={k} />
                </Slot>
                <span>→</span>
                <Slot k={k}>
                  <TintedItem path={path} layers={BOTTLES[0]} colors={[color, NO_TINT]} size={16 * k} />
                </Slot>
              </div>
            ))}
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
    invoke<{ url: string }>("content_texture", { path, texture }).then(
      (x) => live && setUrl(x.url),
      () => live && setUrl(null),
    );
    return () => {
      live = false;
    };
  }, [path, texture]);
  return url;
}
