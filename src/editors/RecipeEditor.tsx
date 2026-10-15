import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ItemHeader, ItemIcons } from "../designer/ItemIcons";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarInput, ToolbarLabel, ToolbarSelect, usePropertyContext, useT, type EditorProps, type PropertyDescriptor, type PropertySet, type PropertyValue, fileTypeOf } from "substrate-platform-ui";
import { DataEditor } from "./DataEditor";
import { parseDataValue } from "../data/yogData";
import { iconSource, imagePreview, imageSources, imageSourcesVersion, ingredientItems, subscribeImageSources } from "../designer/imageSources";
import { openFile } from "../fileOpenBus";
import { useFsChanged } from "../fsWatch";
import {
  customFrom,
  emptyRecipe,
  parseCustomRecipe,
  parseRecipe,
  serializeCustomRecipe,
  serializeRecipe,
  type CustomRecipe,
  type Recipe,
  type RecipeKind,
  type RecipeType,
} from "./recipeModel";
import "./RecipeEditor.css";

/** The code view of a `.yrecipe` (registered in `editors/index.tsx`). */
export const RECIPE_SOURCE_VIEW = "yog.recipe.source";

/** `recipe_kinds`: the game's kinds the editor lays out, and the mod's own. */
interface Kinds {
  game: RecipeKind[];
  own: RecipeKind[];
}

/**
 * Which place the inspector edits: `g:<i>` a game recipe's cell, `result`,
 * or `s:<slot>:<i>` a place of a mod kind's slot.
 */
type Target = string;

/**
 * The kinds (`null` until known) and a way to ask again — asked again
 * whenever a `.ydef` or `.yui` changes on disk.
 */
function useRecipeKinds(path: string): [Kinds | null, () => void] {
  const [kinds, setKinds] = useState<Kinds | null>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    void invoke<Kinds>("recipe_kinds", { path })
      .then((k) => live && setKinds(k))
      .catch(() => live && setKinds({ game: [], own: [] }));
    return () => {
      live = false;
    };
  }, [path, asked]);
  useFsChanged((paths) => {
    if (paths.some((p) => ["yog.ydef", "yog.yui"].includes(fileTypeOf(p)?.id ?? ""))) reload();
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

/**
 * `.yrecipe` files, every kind drawn the same way: as books show it — the
 * game's kinds by their built-in layouts (the crafting table, the furnace),
 * the mod's (`.ydef` `recipe_kind`) by their `.yui` layout — on a GUI
 * panel scaled to the editor. Click a place, then pick its item in the
 * inspector — typed with its namespace (`minecraft:paper`) or a tag
 * (`#c:dusts`), the game's and the mod's items offered; the inspector also
 * holds the result's count and the kind's values.
 */
/** The game's recipe kinds as the editor names them. */
const GAME_LABELS: Record<string, string> = {
  shaped: "Shaped",
  shapeless: "Shapeless",
  smelting: "Smelting",
  blasting: "Blasting",
  smoking: "Smoking",
  campfire_cooking: "Campfire Cooking",
  stonecutting: "Stonecutting",
};

export function RecipeEditor({ path, content, onChange, readOnly }: EditorProps) {
  const t = useT();
  useSyncExternalStore(subscribeImageSources, imageSourcesVersion);
  const [kinds, reloadKinds] = useRecipeKinds(path);
  const game = useMemo(() => parseRecipe(content), [content]);
  const custom = useMemo(() => parseCustomRecipe(content), [content]);
  const recipe = game ?? emptyRecipe();
  const typeId = custom ? custom.type : recipe.type;
  const kind = kinds ? (custom ? kinds.own : kinds.game).find((k) => k.id === typeId) : undefined;
  const [target, setTarget] = useState<Target>("g:0");
  const [newKind, setNewKind] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Slots with several possible items (tags, alternatives) show the next each second.
  const [cycleTick, setCycleTick] = useState(0);
  useEffect(() => {
    const h = window.setInterval(() => setCycleTick((n) => n + 1), 1000);
    return () => window.clearInterval(h);
  }, []);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const [stageW, stageH] = useSize(stageEl);

  const valueAt = (at: Target): string => {
    if (at === "result") return (custom ?? recipe).result;
    if (at.startsWith("s:") && custom) {
      const [, slot, i] = at.split(":");
      return custom.slots[slot]?.[Number(i)] ?? "";
    }
    if (at.startsWith("g:")) return recipe.cells[Number(at.slice(2))] ?? "";
    return "";
  };
  const current = valueAt(target);

  const write = useCallback(
    (text: string) => {
      if (!readOnly && text !== content) onChange(text);
    },
    [content, onChange, readOnly]
  );
  const updateGame = (change: (r: Recipe) => void) => {
    const next: Recipe = { ...recipe, cells: [...recipe.cells], extra: { ...recipe.extra } };
    change(next);
    write(serializeRecipe(next));
  };
  const updateCustom = (change: (r: CustomRecipe) => void) => {
    if (!custom) return;
    const next: CustomRecipe = {
      ...custom,
      slots: Object.fromEntries(Object.entries(custom.slots).map(([k, v]) => [k, [...v]])),
      values: { ...custom.values },
      extra: { ...custom.extra },
    };
    change(next);
    write(serializeCustomRecipe(next, kind));
  };

  /** Sets what `at` holds (`""`: empty). */
  const put = (at: Target, value: string) => {
    const v = value.trim();
    if (custom) {
      updateCustom((r) => {
        if (at === "result") r.result = v;
        else if (at.startsWith("s:")) {
          const [, slot, i] = at.split(":");
          const cells = r.slots[slot] ?? (r.slots[slot] = []);
          cells[Number(i)] = v || null;
        }
      });
    } else {
      updateGame((r) => {
        if (at === "result") r.result = v;
        else if (at.startsWith("g:")) r.cells[Number(at.slice(2))] = v || null;
      });
    }
  };

  const items = useMemo(
    () =>
      imageSources(path)
        .filter((c) => c.group === "item" || c.group === "block")
        .map((c) => c.source.replace(/^(item|block):/, ""))
        .map((id) => (id.includes(":") ? id : `minecraft:${id}`))
        .filter((id, i, all) => all.indexOf(id) === i),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path, imageSourcesVersion()]
  );

  if (!game && !custom && content.trim() !== "") {
    let typed = false;
    try {
      const v = parseDataValue(content);
      typed = !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as Record<string, unknown>).type === "string";
    } catch {
      typed = false;
    }
    // Not an object, or broken text: fixed in the Code view, never overwritten from here.
    if (!typed) return <div className="recipe-editor recipe-error">{t("This isn't a recipe (a JSON object) — fix it in the Code view.")}</div>;
    // One of the game's kinds the editor doesn't lay out (blasting, smithing…): its fields, from the schema.
    return <DataEditor path={path} content={content} onChange={onChange} readOnly={readOnly} format="yrecipe" sourceView={RECIPE_SOURCE_VIEW} />;
  }
  // What Properties shows while the recipe is active (set once it's drawn, below).
  const shownProperties = useRef<PropertySet | null>(null);
  shownProperties.current = null;
  usePropertyContext(path, () => shownProperties.current);

  if (!kinds) return <div className="recipe-editor" />;
  // A kind this mod doesn't declare (another mod's): its fields, from the schema.
  if (custom && !kind) {
    return <DataEditor path={path} content={content} onChange={onChange} readOnly={readOnly} format="yrecipe" sourceView={RECIPE_SOURCE_VIEW} />;
  }

  const switchTo = (type: string) => {
    const from = custom ?? recipe;
    const own = kinds.own.find((x) => x.id === type);
    if (own) {
      if (custom?.type !== own.id) write(serializeCustomRecipe(customFrom(own, from), own));
      const first = own.slots[0];
      setTarget(first ? `s:${first.name}:0` : "result");
      return;
    }
    const next = game && !custom ? { ...recipe } : { ...emptyRecipe(), result: from.result, count: from.count };
    next.type = type as RecipeType;
    write(serializeRecipe(next));
    setTarget("g:0");
  };

  const createKind = async (name: string) => {
    try {
      const file = await invoke<string>("recipe_kind_create", { path, name });
      setNewKind(null);
      setError(null);
      reloadKinds();
      openFile({ path: file });
    } catch (e) {
      setError(String(e));
    }
  };

  const gameLabel = (id: string) => t(GAME_LABELS[id] ?? id);
  const kindOptions = [
    ...kinds.game.map((k) => ({ value: k.id, label: gameLabel(k.id), group: t("Minecraft") })),
    ...kinds.own.map((k) => ({ value: k.id, label: k.id.split(":").pop() ?? k.id, group: t("This mod") })),
  ];

  const toolbar = (
    <Toolbar>
      <ToolbarGroup>
        <ToolbarSelect value={typeId} options={kindOptions} disabled={readOnly} onChange={switchTo} />
        {custom && kind && <ToolbarButton icon="settings" label="Edit kind…" onClick={() => openFile({ path: kind.file })} />}
        {kind?.layout?.file && <ToolbarButton icon="grid" label="Edit layout…" onClick={() => openFile({ path: kind.layout!.file })} />}
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

  /** An ingredient's item shown now: its alternatives and tags' items in turn, a second each, as JEI does. */
  const cycled = (value: string): string | null => {
    const items = ingredientItems(path, value);
    return items.length ? items[cycleTick % items.length] : null;
  };

  /** The `n`-th place of game slot `slot` (`grid`, `input`) as a target. */
  const gameTarget = (slot: string, index: number) => (slot === "grid" ? `g:${index}` : `g:0`);
  const words = (text: string) =>
    text.replace(/\{(\w+)\}/g, (_, name: string) => {
      if (custom) return String(custom.values[name] ?? "");
      if (name === "time" || name === "cook_time") return String(recipe.cookTime);
      if (name === "experience") return String(recipe.experience);
      return "";
    });

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
        onClick={() => {
          setTarget(at);
        }}
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

  const layout = kind?.layout;
  // As big as fits the stage (its padding and the panel's border aside), in
  // whole steps so the pixel art stays crisp.
  const k = layout
    ? Math.max(2, Math.min(6, Math.floor(Math.min((stageW - 64) / (layout.size[0] + 8), (stageH - 64) / (layout.size[1] + 8)))))
    : 3;
  const count = custom ? custom.count : recipe.count;
  const stage = layout ? (
    <div className="recipe-panel" style={{ width: layout.size[0] * k, height: layout.size[1] * k, padding: 4 * k }}>
      <div className="recipe-panel-inner" style={{ width: layout.size[0] * k, height: layout.size[1] * k }}>
        {layout.image && <img className="recipe-layout-image" src={layout.image} alt="" />}
        {layout.spots.map((s, i) => {
          const pos = { left: s.at[0] * k, top: s.at[1] * k };
          if (s.type === "slot") return cell(custom ? `s:${s.slot}:${s.index}` : gameTarget(s.slot, s.index), pos, 16 * k);
          if (s.type === "result") return cell("result", pos, 16 * k);
          if (s.type === "count")
            return count > 1 ? (
              <span key={`c${i}`} className="recipe-layout-text" style={{ ...pos, fontSize: 8 * k }}>
                {count}
              </span>
            ) : null;
          return (
            <span key={`t${i}`} className="recipe-layout-text" style={{ ...pos, fontSize: 8 * k }}>
              {words(s.text)}
            </span>
          );
        })}
      </div>
    </div>
  ) : (
    // A mod's kind without a layout: its slots in rows.
    <div className="recipe-panel recipe-panel-rows">
      {kind?.slots.map((s) => (
        <div key={s.name} className="recipe-slot-row">
          <span className="recipe-slot-name">
            {s.name}
            {s.required && " *"}
          </span>
          {Array.from({ length: s.max }, (_, i) => cell(custom ? `s:${s.name}:${i}` : gameTarget(s.name, i), { position: "relative" }, 48))}
        </div>
      ))}
      <div className="recipe-slot-row">
        <span className="recipe-slot-name">{t("Result")}</span>
        {cell("result", { position: "relative" }, 48)}
      </div>
    </div>
  );

  const targetLabel =
    target === "result"
      ? t("Result")
      : target.startsWith("s:")
        ? `${target.split(":")[1]} ${Number(target.split(":")[2]) + 1}`
        : t("Ingredient {n}", { n: Number(target.slice(2)) + 1 });
  const targetIcon = (() => {
    const shown = current ? cycled(current) : null;
    return shown ? imagePreview(path, iconSource(shown)) : null;
  })();
  /** The inspector: the selected place, the result, the recipe's values. */
  const ro = !!readOnly;
  const clampCount = (n: number) => Math.max(1, Math.min(64, Math.round(n)));
  const inspected: PropertyDescriptor[] = [
    {
      id: "place",
      category: targetLabel,
      name: target === "result" ? t("Result") : t("Ingredient"),
      value: current,
      image: targetIcon ?? undefined,
      suggestions: items,
      description: t("An item, a tag (#c:dusts), or alternatives joined by |. Right-click a place to empty it."),
      readOnly: ro,
      onCommit: (v) => put(target, String(v)),
    },
    // A tag or alternatives: the items they stand for — pick one to use it alone.
    ...(current && (current.includes("#") || current.includes("|"))
      ? [
          {
            id: "matches",
            category: targetLabel,
            name: t("Matches"),
            value: null,
            render: () => <ItemIcons path={path} items={ingredientItems(path, current)} onPick={ro ? undefined : (id) => put(target, id)} empty={t("No item matches it (yet).")} />,
          } satisfies PropertyDescriptor,
        ]
      : []),
    // What it makes, whichever place is selected.
    ...(target !== "result"
      ? [
          {
            id: "result",
            category: t("Result"),
            name: t("Item"),
            value: valueAt("result"),
            image: valueAt("result") ? (imagePreview(path, iconSource(valueAt("result"))) ?? undefined) : undefined,
            suggestions: items,
            readOnly: ro,
            onCommit: (v: PropertyValue) => put("result", String(v)),
          } satisfies PropertyDescriptor,
        ]
      : []),
    {
      id: "count",
      category: t("Result"),
      name: t("Count"),
      value: count,
      validate: (v) => (Number(v) >= 1 && Number(v) <= 64 ? null : t("1 to 64")),
      readOnly: ro,
      onCommit: (v) => (custom ? updateCustom((r) => (r.count = clampCount(Number(v)))) : updateGame((r) => (r.count = clampCount(Number(v))))),
    },
  ];
  if (!custom && isCooking(recipe.type)) {
    inspected.push(
      { id: "experience", category: t("Cooking"), name: t("Experience"), value: recipe.experience, step: 0.1, readOnly: ro, onCommit: (v) => updateGame((r) => (r.experience = Math.max(0, Number(v)))) },
      { id: "cook_time", category: t("Cooking"), name: t("Cook time (ticks)"), value: recipe.cookTime, readOnly: ro, onCommit: (v) => updateGame((r) => (r.cookTime = Math.max(1, Math.round(Number(v))))) },
    );
  }
  if (custom && kind) {
    for (const v of kind.values) {
      const value = custom.values[v.name];
      inspected.push({
        id: `value.${v.name}`,
        category: t("Values"),
        name: v.name,
        value: v.kind === "bool" ? !!value : v.kind === "number" ? Number(value ?? 0) : String(value ?? ""),
        readOnly: ro,
        onCommit: (x) => updateCustom((r) => (r.values[v.name] = x as never)),
      });
    }
  }

  // What Properties shows while the recipe is active: the selected place, the result, the recipe's values.
  shownProperties.current = {
    header: <ItemHeader path={path} item={current ? cycled(current) : null} caption={targetLabel} />,
    order: "declared",
    objectName: targetLabel,
    objectType: t("Recipe"),
    objectKey: target,
    objectDescription: t("An item, a tag (#c:dusts), or alternatives joined by |. Right-click a place to empty it."),
    properties: inspected,
  };

  return (
    <div className="recipe-editor">
      {toolbar}
      <div className="recipe-body">
        <div className="recipe-stage" ref={setStageEl}>
          {stage}
          {!layout && !kind?.slots.length && <p className="recipe-hint">{t("No layout: give the kind a .yui layout (Edit layout… after New kind…) to draw it as books do.")}</p>}
        </div>
      </div>
    </div>
  );
}
