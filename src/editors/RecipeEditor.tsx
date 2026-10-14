import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FormField, FormSection, Icon, IconButton, SelectField, useT, type EditorProps } from "substrate-platform-ui";
import { DataEditor } from "./DataEditor";
import { parseDataValue } from "../data/yogData";
import { imagePreview, imageSources, imageSourcesVersion, subscribeImageSources } from "../designer/imageSources";
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
    if (paths.some((p) => p.endsWith(".ydef") || p.endsWith(".yui"))) reload();
  });
  return [kinds, reload];
}

/** The width of `ref`'s element, kept current. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
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
  const [draft, setDraft] = useState("");
  const [newKind, setNewKind] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const stageWidth = useWidth(stageRef);

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
  useEffect(() => setDraft(current), [current, target]);

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
        .map((id) => (id.includes(":") ? id : `minecraft:${id}`)),
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

  const gameLabel = (id: string) => t(id === "shaped" ? "Shaped" : id === "shapeless" ? "Shapeless" : id === "smelting" ? "Smelting" : id);
  const kindOptions = [
    ...kinds.game.map((k) => ({ value: k.id, label: gameLabel(k.id), group: t("Minecraft") })),
    ...kinds.own.map((k) => ({ value: k.id, label: k.id.split(":").pop() ?? k.id, group: t("This mod") })),
  ];

  const toolbar = (
    <div className="recipe-bar">
      <SelectField aria-label={t("Kind of recipe")} value={typeId} options={kindOptions} disabled={readOnly} onChange={switchTo} />
      {custom && kind && (
        <IconButton title={t("Edit kind…")} onClick={() => openFile({ path: kind.file })}>
          <Icon name="settings" />
        </IconButton>
      )}
      {kind?.layout?.file && (
        <IconButton title={t("Edit layout…")} onClick={() => openFile({ path: kind.layout!.file })}>
          <Icon name="grid" />
        </IconButton>
      )}
      <span className="recipe-bar-sep" />
      {newKind === null ? (
        <IconButton title={t("New kind…")} disabled={readOnly} onClick={() => setNewKind("")}>
          <Icon name="plus" />
        </IconButton>
      ) : (
        <span className="recipe-newkind">
          <input
            autoFocus
            value={newKind}
            placeholder={t("crusher")}
            onChange={(e) => setNewKind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newKind.trim()) void createKind(newKind);
              if (e.key === "Escape") setNewKind(null);
            }}
          />
          <IconButton title={t("Create")} disabled={!newKind.trim()} onClick={() => void createKind(newKind)}>
            <Icon name="check" />
          </IconButton>
          <IconButton
            title={t("Cancel")}
            onClick={() => {
              setNewKind(null);
              setError(null);
            }}
          >
            <Icon name="close" />
          </IconButton>
        </span>
      )}
      {error && <span className="recipe-bar-error">{error}</span>}
    </div>
  );

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
    const first = value?.split("|")[0].trim();
    const icon = first && !first.startsWith("#") ? imagePreview(path, `item:${first}`) : null;
    return (
      <button
        key={at}
        type="button"
        className={`recipe-spot${target === at ? " selected" : ""}`}
        style={{ ...style, width: size, height: size }}
        title={value ?? t("Empty — click, then pick an item")}
        onClick={() => {
          setTarget(at);
          inputRef.current?.focus();
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
  // As big as fits the stage, in whole steps (pixel art stays crisp).
  const k = layout ? Math.max(2, Math.min(6, Math.floor((stageWidth - 48) / layout.size[0]))) : 3;
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
    const first = current.split("|")[0].trim();
    return first && !first.startsWith("#") ? imagePreview(path, `item:${first}`) : null;
  })();
  const number = (value: number, set: (n: number) => void, opts: { min?: number; max?: number; step?: number } = {}) => (
    <input type="number" className="recipe-input" value={value} min={opts.min} max={opts.max} step={opts.step} disabled={readOnly} onChange={(e) => set(Number(e.target.value) || 0)} />
  );

  return (
    <div className="recipe-editor">
      {toolbar}
      <div className="recipe-body">
        <div className="recipe-stage" ref={stageRef}>
          {stage}
          {!layout && !kind?.slots.length && <p className="recipe-hint">{t("No layout: give the kind a .yui layout (Edit layout… after New kind…) to draw it as books do.")}</p>}
        </div>
        <aside className="recipe-inspector">
          <FormSection title={targetLabel}>
            <div className="recipe-picked">
              <div className="recipe-picked-icon">{targetIcon && <img src={targetIcon} alt="" />}</div>
              <input
                ref={inputRef}
                className="recipe-input"
                list="recipe-items"
                value={draft}
                disabled={readOnly}
                placeholder={target === "result" ? "minecraft:paper" : "minecraft:paper | #c:dusts"}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => put(target, draft)}
                onKeyDown={(e) => e.key === "Enter" && put(target, draft)}
              />
            </div>
            <datalist id="recipe-items">
              {items.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            <p className="recipe-hint">{t("An item, a tag (#c:dusts), or alternatives joined by |. Right-click a place to empty it.")}</p>
          </FormSection>
          <FormSection title={t("Result")}>
            <FormField label={t("Count")}>
              {number(count, (n) => (custom ? updateCustom((r) => (r.count = Math.max(1, Math.min(64, n)))) : updateGame((r) => (r.count = Math.max(1, Math.min(64, n))))), { min: 1, max: 64 })}
            </FormField>
          </FormSection>
          {!custom && recipe.type === "smelting" && (
            <FormSection title={t("Smelting")}>
              <FormField label={t("Experience")}>{number(recipe.experience, (n) => updateGame((r) => (r.experience = Math.max(0, n))), { min: 0, step: 0.1 })}</FormField>
              <FormField label={t("Cook time (ticks)")}>{number(recipe.cookTime, (n) => updateGame((r) => (r.cookTime = Math.max(1, Math.round(n)))), { min: 1 })}</FormField>
            </FormSection>
          )}
          {custom && kind && kind.values.length > 0 && (
            <FormSection title={t("Values")}>
              {kind.values.map((v) => (
                <FormField key={v.name} label={v.name}>
                  {v.kind === "bool" ? (
                    <input type="checkbox" checked={!!custom.values[v.name]} disabled={readOnly} onChange={(e) => updateCustom((r) => (r.values[v.name] = e.target.checked))} />
                  ) : v.kind === "number" ? (
                    number(Number(custom.values[v.name] ?? 0), (n) => updateCustom((r) => (r.values[v.name] = n)))
                  ) : (
                    <input className="recipe-input" value={String(custom.values[v.name] ?? "")} disabled={readOnly} onChange={(e) => updateCustom((r) => (r.values[v.name] = e.target.value))} />
                  )}
                </FormField>
              ))}
            </FormSection>
          )}
        </aside>
      </div>
    </div>
  );
}
