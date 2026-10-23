import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useTyped } from "../../data/typed";
import { cli } from "../../toolchain/cli";
import { ItemHeader, ItemIcons } from "../../designer/view/ItemIcons";
import { type EditorProps, fileTypeOf, openFile, type PropertyDescriptor, type PropertySet, type PropertyValue, Toolbar, ToolbarButton, ToolbarGroup, ToolbarInput, ToolbarLabel, ToolbarSelect, useFilesChanged, usePropertyContext, useT } from "substrate-platform-ui";
import { DataEditor } from "../data/DataEditor";
import { typedRef, useContentRefs } from "../../data/contentRefs";
import { alternativesOf, isTag } from "../../data/ingredients";
import { MAX_STACK_SIZE } from "../../data/yogFormat";
import { iconSource, imagePreview, imageSources, imageSourcesVersion, ingredientItems, subscribeImageSources } from "../../designer/resources/imageSources";
import { useDataFile, type DataFormat } from "../../data/useDataFile";
import { readObject } from "../../data/yogData";
import { recipeOf, switchedTo, typeOf, withRecipe, type Recipe, type RecipeFields, type RecipeKind, type RecipeSlot } from "./recipeModel";
import "../RecipeEditor.css";
import { fileTypeId, formats } from "../../project/yogFileTypes";
import { kind as KIND, serveMethod } from "../../data/yogIds.generated";

/** The code view of a `.yrecipe` (registered in `editors/index.tsx`). */
export const RECIPE_SOURCE_VIEW = "yog.recipe.source";

/** `recipe_kinds`: the game's kinds, the mod's own, the format's field names. */
interface Kinds {
  game: RecipeKind[];
  own: RecipeKind[];
  fields: RecipeFields;
}

/** Which place the inspector edits: `s:<slot>:<index>`, or the result. */
type Target = string;
const RESULT: Target = "result";
const SLOT_TARGET = "s";
const placeTarget = (slot: string, index: number): Target => `${SLOT_TARGET}:${slot}:${index}`;
const targetPlace = (at: Target): { slot: string; index: number } | null => {
  const [kind, slot, index] = at.split(":");
  return kind === SLOT_TARGET && slot ? { slot, index: Number(index) } : null;
};

/** How long a place with several items (a tag, alternatives) shows each. */
const CYCLE_MS = 1000;
/** An item's side, and the text's size, in GUI pixels. */
const ITEM_PX = 16;
const TEXT_PX = 8;
/** The picture's scale: whole steps (crisp pixel art) between these, fitting the stage less its margin. */
const MIN_SCALE = 2;
const MAX_SCALE = 6;
const FALLBACK_SCALE = 3;
const STAGE_MARGIN = 64;
const PANEL_BORDER = 8;
const PANEL_PADDING = 4;
/** A place's side, in a kind's slots shown as rows (no layout). */
const ROW_PLACE_PX = 48;

/** The kinds (`null` until known), asked again whenever a `.ydef` or `.yui` changes on disk. */
function useRecipeKinds(path: string): [Kinds | null, () => void] {
  const [kinds, setKinds] = useState<Kinds | null>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    void cli<Kinds>(serveMethod.RECIPE_KINDS, { path }).then(
      (k) => live && setKinds(k),
      () => live && setKinds(null),
    );
    return () => {
      live = false;
    };
  }, [path, asked]);
  useFilesChanged((paths) => {
    if (paths.some((p) => [fileTypeId(formats.def), fileTypeId(formats.ui)].includes(fileTypeOf(p)?.id ?? ""))) reload();
  });
  return [kinds, reload];
}

/** The size of `el` (mounted later than the editor: a callback ref's), kept current. */
function useSize(el: HTMLElement | null): [number, number] {
  const [size, setSize] = useState<[number, number]>([0, 0]);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setSize([el.clientWidth, el.clientHeight]);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [el]);
  return size;
}

/** A value's label from its name: `cook_time` → `Cook time`. */
const labelOf = (name: string) => (name.charAt(0).toUpperCase() + name.slice(1)).replace(/_/g, " ");

/** A `.yrecipe`: one object, read and written through the CLI. */
const RECIPE_FORMAT: DataFormat<Record<string, unknown>> = { read: readObject<Record<string, unknown>> };

/**
 * `.yrecipe` files, every kind drawn the same way: as books show it — by
 * its layout (built in for the game's kinds, a `.yui` `recipe_layout` for a
 * mod's) on a GUI panel scaled to the editor. Click a place, then pick its
 * item in the inspector — an id (`minecraft:paper`), a tag (`#c:dusts`) or
 * alternatives; the inspector also holds the result, its count and the
 * kind's values.
 */
export function RecipeEditor({ path, content, onChange, readOnly }: EditorProps) {
    const t = useT();
  useSyncExternalStore(subscribeImageSources, imageSourcesVersion);
  const [kinds, reloadKinds] = useRecipeKinds(path);
  const itemRefs = useContentRefs(path, KIND.ITEM);
  const all = useMemo(() => (kinds ? [...kinds.game, ...kinds.own] : []), [kinds]);
  const { parsed, update: edit } = useDataFile(content, onChange, RECIPE_FORMAT, readOnly);
  const object = parsed?.ok ? parsed.file : null;
  const typeId = kinds && object ? typeOf(object, kinds.fields) : null;
  const kind = all.find((k) => k.id === typeId);
  // Read again when typed values come in (`useTyped` above).
  const typed = useTyped();
  const recipe = useMemo(() => (kind && kinds && object ? recipeOf(object, kind, kinds.fields) : null), [object, kind, kinds, typed]);
  const [target, setTarget] = useState<Target>(RESULT);
  const [newKind, setNewKind] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Places with several possible items (tags, alternatives) show the next each cycle.
  const [cycleTick, setCycleTick] = useState(0);
  useEffect(() => {
    const h = window.setInterval(() => setCycleTick((n) => n + 1), CYCLE_MS);
    return () => window.clearInterval(h);
  }, []);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const [stageW, stageH] = useSize(stageEl);
  // What Properties shows while the recipe is active (set once it's drawn, below).
  const shownProperties = useRef<PropertySet | null>(null);
  shownProperties.current = null;
  usePropertyContext(path, () => shownProperties.current);

  /** Everything an ingredient can be: the mod's items, other mods', the game's. */
  const items = useMemo(
    () =>
      [
        ...itemRefs.own.map((p) => p.id),
        ...itemRefs.external,
        ...itemRefs.game,
        ...imageSources(path)
          .filter((c) => c.group === KIND.ITEM || c.group === KIND.BLOCK)
          .map((c) => c.source.replace(/^(item|block):/, "")),
      ].filter((id, i, list) => list.indexOf(id) === i),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- image sources change by version
    [itemRefs, path, imageSourcesVersion()],
  );

  if (!kinds || !parsed) return <div className="recipe-editor" />;
  // Not a kind this mod knows (another mod's, a typo): its fields, from the schema.
  if (!kind || !recipe) return <DataEditor path={path} content={content} onChange={onChange} readOnly={readOnly} format={formats.recipe.ext} sourceView={RECIPE_SOURCE_VIEW} />;

  const write = (next: Recipe) => void edit((o) => withRecipe(o, next, kind, kinds.fields));
  const update = (change: (r: Recipe) => void) => {
    const next: Recipe = { ...recipe, slots: Object.fromEntries(Object.entries(recipe.slots).map(([k, v]) => [k, [...v]])), values: { ...recipe.values } };
    change(next);
    write(next);
  };

  const valueAt = (at: Target): string => {
    if (at === RESULT) return recipe.result;
    const place = targetPlace(at);
    return place ? (recipe.slots[place.slot]?.[place.index] ?? "") : "";
  };
  /** Sets what `at` holds (`""`: empty). */
  const put = (at: Target, value: string) => {
    const v = value.trim();
    update((r) => {
      if (at === RESULT) r.result = v;
      const place = targetPlace(at);
      if (place) (r.slots[place.slot] ??= [])[place.index] = v || null;
    });
  };

  const switchTo = (id: string) => {
    const next = all.find((k) => k.id === id);
    if (!next || next.id === kind.id) return;
    void edit((o) => switchedTo(o, recipe, next, all, kinds.fields));
    setTarget(next.slots[0] ? placeTarget(next.slots[0].name, 0) : RESULT);
  };

  const createKind = async (name: string) => {
    try {
      const file = await cli<string>(serveMethod.RECIPE_KIND_CREATE, { path, name });
      setNewKind(null);
      setError(null);
      reloadKinds();
      openFile({ path: file });
    } catch (e) {
      setError(String(e));
    }
  };

  const kindLabel = (k: RecipeKind) => t(k.label ?? k.id.split(":").pop() ?? k.id);
  const kindOptions = [
    ...kinds.game.map((k) => ({ value: k.id, label: kindLabel(k), group: t("Minecraft") })),
    ...kinds.own.map((k) => ({ value: k.id, label: kindLabel(k), group: t("This mod") })),
  ];

  const toolbar = (
    <Toolbar>
      <ToolbarGroup>
        <ToolbarSelect value={kind.id} options={kindOptions} disabled={readOnly} onChange={switchTo} />
        {kind.file && <ToolbarButton icon="settings" label="Edit kind…" onClick={() => openFile({ path: kind.file })} />}
        {kind.layout?.file && <ToolbarButton icon="grid" label="Edit layout…" onClick={() => openFile({ path: kind.layout!.file })} />}
      </ToolbarGroup>
      <ToolbarGroup>
        {newKind === null ? (
          <ToolbarButton icon="plus" label="New kind…" disabled={readOnly} onClick={() => setNewKind("")} />
        ) : (
          <ToolbarInput
            value={newKind}
            placeholder={t("crusher")}
            onChange={setNewKind}
            onSubmit={(name) => void createKind(name)}
            onCancel={() => {
              setNewKind(null);
              setError(null);
            }}
          />
        )}
      </ToolbarGroup>
      {error && <ToolbarLabel tone="error">{error}</ToolbarLabel>}
    </Toolbar>
  );

  /** An ingredient's item shown now: its alternatives and tags' items in turn, as JEI does. */
  const cycled = (value: string): string | null => {
    const list = ingredientItems(path, value);
    return list.length ? list[cycleTick % list.length] : null;
  };
  /** A layout's text with the recipe's values in `{name}`s. */
  const words = (text: string) => text.replace(/\{(\w+)\}/g, (_, name: string) => String(recipe.values[name] ?? ""));

  const cell = (at: Target, style: CSSProperties, size: number) => {
    const value = valueAt(at) || null;
    const shown = value ? cycled(value) : null;
    const icon = shown ? imagePreview(path, iconSource(shown)) : null;
    return (
      <button
        key={at}
        type="button"
        className={`recipe-spot${target === at ? " selected" : ""}`}
        style={{ ...style, width: size, height: size }}
        title={value ? (shown && shown !== value ? `${value} — ${shown}` : value) : t("Empty — click, then pick an item")}
        onClick={() => setTarget(at)}
        onContextMenu={(e) => {
          e.preventDefault();
          setTarget(at);
          put(at, "");
        }}
      >
        {icon ? <img src={icon} alt="" /> : value ? <span className="recipe-cell-text">{value.split(":").pop()}</span> : null}
      </button>
    );
  };

  const layout = kind.layout;
  const k = layout
    ? Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.floor(Math.min((stageW - STAGE_MARGIN) / (layout.size[0] + PANEL_BORDER), (stageH - STAGE_MARGIN) / (layout.size[1] + PANEL_BORDER)))))
    : FALLBACK_SCALE;
  const stage = layout ? (
    <div className="recipe-panel" style={{ width: layout.size[0] * k, height: layout.size[1] * k, padding: PANEL_PADDING * k }}>
      <div className="recipe-panel-inner" style={{ width: layout.size[0] * k, height: layout.size[1] * k }}>
        {layout.image && <img className="recipe-layout-image" src={layout.image} alt="" />}
        {layout.spots.map((s, i) => {
          const pos = { left: s.at[0] * k, top: s.at[1] * k };
          if (s.type === "slot") return cell(placeTarget(s.slot, s.index), pos, ITEM_PX * k);
          if (s.type === "result") return cell(RESULT, pos, ITEM_PX * k);
          const text = s.type === "count" ? (recipe.count > 1 ? String(recipe.count) : "") : words(s.text);
          return text ? (
            <span key={`t${i}`} className="recipe-layout-text" style={{ ...pos, fontSize: TEXT_PX * k }}>
              {text}
            </span>
          ) : null;
        })}
      </div>
    </div>
  ) : (
    // A kind without a layout: its slots in rows.
    <div className="recipe-panel recipe-panel-rows">
      {kind.slots.map((s) => (
        <div key={s.name} className="recipe-slot-row">
          <span className="recipe-slot-name">
            {t(s.label ?? labelOf(s.name))}
            {s.required && " *"}
          </span>
          {Array.from({ length: s.max }, (_, i) => cell(placeTarget(s.name, i), { position: "relative" }, ROW_PLACE_PX))}
        </div>
      ))}
      <div className="recipe-slot-row">
        <span className="recipe-slot-name">{t("Result")}</span>
        {cell(RESULT, { position: "relative" }, ROW_PLACE_PX)}
      </div>
    </div>
  );

  // The inspector: the selected place, the result, the recipe's values.
  const place = targetPlace(target);
  const slot: RecipeSlot | undefined = place ? kind.slots.find((s) => s.name === place.slot) : undefined;
  const current = valueAt(target);
  const hint = t("An item, a tag (#c:dusts), or alternatives joined by |. Right-click a place to empty it.");
  const placeDescription = slot?.description ? `${t(slot.description)} ${hint}` : hint;
  const targetLabel = target === RESULT ? t("Result") : slot ? (slot.max > 1 ? `${t(slot.label ?? labelOf(slot.name))} ${place!.index + 1}` : t(slot.label ?? labelOf(slot.name))) : t("Ingredient");
  const shown = current ? cycled(current) : null;
  const ro = !!readOnly;
  const clampCount = (n: number) => Math.max(1, Math.min(MAX_STACK_SIZE, Math.round(n)));
  const inspected: PropertyDescriptor[] = [
    {
      id: "place",
      category: targetLabel,
      name: target === RESULT ? t("Result") : t("Ingredient"),
      value: current,
      image: shown ? (imagePreview(path, iconSource(shown)) ?? undefined) : undefined,
      suggestions: items,
      description: placeDescription,
      readOnly: ro,
      onCommit: (v) => put(target, String(v)),
    },
    // A tag or alternatives: the items they stand for — pick one to use it alone.
    ...(current && alternativesOf(current).some((p, _, parts) => isTag(p) || parts.length > 1)
      ? [
          {
            id: "matches",
            category: targetLabel,
            name: t("Matches"),
            value: null,
            render: () => <ItemIcons path={path} items={ingredientItems(path, current)} onPick={ro ? undefined : (id) => put(target, typedRef(KIND.ITEM, id))} empty={t("No item matches it (yet).")} />,
          } satisfies PropertyDescriptor,
        ]
      : []),
    // What it makes, whichever place is selected.
    ...(target !== RESULT
      ? [
          {
            id: "result",
            category: t("Result"),
            name: t("Item"),
            value: recipe.result,
            image: recipe.result ? (imagePreview(path, iconSource(recipe.result)) ?? undefined) : undefined,
            suggestions: items,
            readOnly: ro,
            onCommit: (v: PropertyValue) => put(RESULT, String(v)),
          } satisfies PropertyDescriptor,
        ]
      : []),
    {
      id: "count",
      category: t("Result"),
      name: t("Count"),
      value: recipe.count,
      validate: (v) => (Number(v) >= 1 && Number(v) <= MAX_STACK_SIZE ? null : t("1 to {max}", { max: MAX_STACK_SIZE })),
      readOnly: ro,
      onCommit: (v) => update((r) => (r.count = clampCount(Number(v)))),
    },
    ...kind.values.map(
      (v): PropertyDescriptor => ({
        id: `value.${v.name}`,
        category: t("Values"),
        name: t(labelOf(v.name)),
        value: v.kind === "bool" ? !!recipe.values[v.name] : v.kind === "number" ? Number(recipe.values[v.name] ?? 0) : String(recipe.values[v.name] ?? ""),
        readOnly: ro,
        onCommit: (x) => update((r) => (r.values[v.name] = v.kind === "number" ? Number(x) : (x as string | boolean))),
      }),
    ),
  ];

  shownProperties.current = {
    header: <ItemHeader path={path} item={shown} caption={targetLabel} />,
    order: "declared",
    objectName: targetLabel,
    objectType: t("Recipe"),
    objectKey: target,
    objectDescription: placeDescription,
    properties: inspected,
  };

  return (
    <div className="recipe-editor">
      {toolbar}
      <div className="recipe-body">
        <div className="recipe-stage" ref={setStageEl}>
          {stage}
          {!layout && !kind.slots.length && <p className="recipe-hint">{t("No layout: give the kind a .yui layout (Edit layout… after New kind…) to draw it as books do.")}</p>}
        </div>
      </div>
    </div>
  );
}
