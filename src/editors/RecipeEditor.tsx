import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT, type EditorProps } from "substrate-platform-ui";
import { DataEditor } from "./DataEditor";
import { parseDataValue } from "../data/yogData";
import { imagePreview, imageSources, imageSourcesVersion, subscribeImageSources } from "../designer/imageSources";
import { openFile } from "../fileOpenBus";
import {
  cellCount,
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

const TYPES: RecipeType[] = ["shaped", "shapeless", "smelting"];
/**
 * Which cell the picker edits: `g:<i>` a grid cell, `result`, or
 * `s:<slot>:<i>` a slot of a mod's kind.
 */
type Target = string;

/** The mod's kinds of recipe (`null` until known), asked again whenever the window comes back (a `.ydef` may have changed). */
function useRecipeKinds(path: string): RecipeKind[] | null {
  const [kinds, setKinds] = useState<RecipeKind[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      void invoke<RecipeKind[]>("recipe_kinds", { path })
        .then((k) => live && setKinds(k))
        .catch(() => live && setKinds([]));
    load();
    window.addEventListener("focus", load);
    return () => {
      live = false;
      window.removeEventListener("focus", load);
    };
  }, [path]);
  return kinds;
}

/**
 * `.yrecipe` files: the game's kinds as a crafting table (or a furnace's
 * one slot), the mod's own kinds (`.ydef` `recipe_kind`) as their layout
 * draws them — or slot by slot when they have none — with their values.
 * Pick a cell, then an item — typed with its namespace (`minecraft:paper`)
 * or a tag (`#c:dusts`), with the game's and the mod's items offered.
 */
export function RecipeEditor({ path, content, onChange, readOnly }: EditorProps) {
  const t = useT();
  useSyncExternalStore(subscribeImageSources, imageSourcesVersion);
  const known = useRecipeKinds(path);
  const kinds = known ?? [];
  const game = useMemo(() => parseRecipe(content), [content]);
  const custom = useMemo(() => parseCustomRecipe(content), [content]);
  const kind = custom ? kinds.find((k) => k.id === custom.type) : undefined;
  const [target, setTarget] = useState<Target>("g:0");
  const [draft, setDraft] = useState("");
  const [newKind, setNewKind] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const recipe = game ?? emptyRecipe();
  const current = (() => {
    if (target === "result") return (custom ?? recipe).result;
    if (target.startsWith("s:") && custom) {
      const [, slot, i] = target.split(":");
      return custom.slots[slot]?.[Number(i)] ?? "";
    }
    if (target.startsWith("g:")) return recipe.cells[Number(target.slice(2))] ?? "";
    return "";
  })();
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
    // One of the game's kinds the table doesn't lay out (blasting, smithing…): its fields, from the schema.
    return <DataEditor path={path} content={content} onChange={onChange} readOnly={readOnly} format="yrecipe" sourceView={RECIPE_SOURCE_VIEW} />;
  }
  if (custom && known === null) return <div className="recipe-editor" />;

  const cell = (at: Target, value: string | null | undefined, className = "recipe-cell", style?: React.CSSProperties) => {
    const icon = value && !value.startsWith("#") ? imagePreview(path, `item:${value.split("|")[0].trim()}`) : null;
    return (
      <button
        key={at}
        type="button"
        className={`${className}${target === at ? " selected" : ""}`}
        style={style}
        title={value ?? t("Empty")}
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

  const switchTo = (type: string) => {
    setTarget("g:0");
    const from = custom ?? recipe;
    const k = kinds.find((x) => x.id === type);
    if (k) {
      if (custom?.type !== k.id) write(serializeCustomRecipe(customFrom(k, from), k));
      const first = k.slots[0];
      setTarget(first ? `s:${first.name}:0` : "result");
      return;
    }
    const next = game && !custom ? { ...recipe } : { ...emptyRecipe(), result: from.result, count: from.count };
    next.type = type as RecipeType;
    write(serializeRecipe(next));
  };

  const createKind = async (name: string) => {
    try {
      const file = await invoke<string>("recipe_kind_create", { path, name });
      setNewKind(null);
      setError(null);
      void openFile({ path: file });
    } catch (e) {
      setError(String(e));
    }
  };

  const activeType = custom ? custom.type : recipe.type;
  const toolbar = (
    <div className="recipe-toolbar">
      {TYPES.map((ty) => (
        <button key={ty} type="button" className={`recipe-type${activeType === ty ? " active" : ""}`} disabled={readOnly} onClick={() => switchTo(ty)}>
          {t(ty === "shaped" ? "Shaped" : ty === "shapeless" ? "Shapeless" : "Smelting")}
        </button>
      ))}
      {kinds.length > 0 && <span className="recipe-toolbar-sep" />}
      {kinds.map((k) => (
        <button key={k.id} type="button" className={`recipe-type${activeType === k.id ? " active" : ""}`} disabled={readOnly} title={k.file} onClick={() => switchTo(k.id)}>
          {k.id.split(":").pop()}
        </button>
      ))}
      {kind && (
        <button type="button" className="recipe-type recipe-type-link" onClick={() => void openFile({ path: kind.file })} title={kind.file}>
          {t("Edit kind…")}
        </button>
      )}
      {kind?.layout && (
        <button type="button" className="recipe-type recipe-type-link" onClick={() => void openFile({ path: kind.layout!.file })} title={kind.layout.file}>
          {t("Edit layout…")}
        </button>
      )}
      {newKind === null ? (
        <button type="button" className="recipe-type recipe-type-link" disabled={readOnly} onClick={() => setNewKind("")}>
          {t("New kind…")}
        </button>
      ) : (
        <span className="recipe-newkind">
          <input
            autoFocus
            value={newKind}
            placeholder="crusher"
            onChange={(e) => setNewKind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createKind(newKind);
              if (e.key === "Escape") setNewKind(null);
            }}
          />
          <button type="button" className="recipe-type" onClick={() => void createKind(newKind)}>
            {t("Create")}
          </button>
        </span>
      )}
    </div>
  );

  const picker = (
    <div className="recipe-picker">
      <span>
        {target === "result"
          ? t("Result")
          : target.startsWith("s:")
            ? `${target.split(":")[1]} ${Number(target.split(":")[2]) + 1}`
            : t("Ingredient {n}", { n: Number(target.slice(2)) + 1 })}
      </span>
      <input
        ref={inputRef}
        list="recipe-items"
        value={draft}
        disabled={readOnly}
        placeholder={target === "result" ? "minecraft:paper" : "minecraft:paper | #c:dusts"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => put(target, draft)}
        onKeyDown={(e) => e.key === "Enter" && put(target, draft)}
      />
      <datalist id="recipe-items">
        {items.map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>
      <span className="recipe-hint">{t("Right-click a cell to empty it.")}</span>
    </div>
  );

  const countField = (value: number, set: (n: number) => void) => (
    <label>
      {t("Count")}
      <input type="number" min={1} max={64} value={value} disabled={readOnly} onChange={(e) => set(Math.max(1, Math.min(64, Number(e.target.value) || 1)))} />
    </label>
  );

  if (custom && kind) {
    const layout = kind.layout;
    const k = layout?.scale ?? 3;
    const words = (text: string) => text.replace(/\{(\w+)\}/g, (_, name: string) => String(custom.values[name] ?? ""));
    return (
      <div className="recipe-editor">
        {toolbar}
        {layout ? (
          <div className="recipe-layout" style={{ width: layout.size[0] * k, height: layout.size[1] * k }}>
            {layout.image && <img className="recipe-layout-image" src={layout.image} alt="" />}
            {layout.spots.map((s, i) => {
              const pos = { left: s.at[0] * k, top: s.at[1] * k };
              if (s.type === "Slot") return cell(`s:${s.slot}:${s.index}`, custom.slots[s.slot]?.[s.index], "recipe-spot", pos);
              if (s.type === "Result") return cell("result", custom.result || null, "recipe-spot", pos);
              if (s.type === "Count")
                return custom.count > 1 ? (
                  <span key={`c${i}`} className="recipe-layout-text" style={pos}>
                    {custom.count}
                  </span>
                ) : null;
              return (
                <span key={`t${i}`} className="recipe-layout-text" style={pos}>
                  {words(s.text)}
                </span>
              );
            })}
          </div>
        ) : (
          <div className="recipe-slots">
            {kind.slots.map((s) => (
              <div key={s.name} className="recipe-slot-row">
                <span className="recipe-slot-name">
                  {s.name}
                  {s.required && " *"}
                </span>
                {Array.from({ length: s.max }, (_, i) => cell(`s:${s.name}:${i}`, custom.slots[s.name]?.[i]))}
              </div>
            ))}
            <div className="recipe-slot-row">
              <span className="recipe-slot-name">{t("Result")}</span>
              {cell("result", custom.result || null)}
            </div>
            <span className="recipe-hint">{t("No layout: lay the kind out in a .yui — <Component recipe_layout=\"{kind}\" width=\"…\" height=\"…\"> — to draw it as books do.", { kind: kind.id.split(":").pop() ?? kind.id })}</span>
          </div>
        )}
        <div className="recipe-furnace">
          {countField(custom.count, (n) => updateCustom((r) => (r.count = n)))}
          {kind.values.map((v) => (
            <label key={v.name}>
              {v.name}
              {v.kind === "bool" ? (
                <input type="checkbox" checked={!!custom.values[v.name]} disabled={readOnly} onChange={(e) => updateCustom((r) => (r.values[v.name] = e.target.checked))} />
              ) : (
                <input
                  type={v.kind === "number" ? "number" : "text"}
                  value={String(custom.values[v.name] ?? "")}
                  disabled={readOnly}
                  onChange={(e) => updateCustom((r) => (r.values[v.name] = v.kind === "number" ? Number(e.target.value) || 0 : e.target.value))}
                />
              )}
            </label>
          ))}
        </div>
        {picker}
        {error && <div className="recipe-error">{error}</div>}
      </div>
    );
  }

  if (custom) {
    // A kind this mod doesn't declare (another mod's): its fields, from the schema.
    return <DataEditor path={path} content={content} onChange={onChange} readOnly={readOnly} format="yrecipe" sourceView={RECIPE_SOURCE_VIEW} />;
  }

  const n = cellCount(recipe.type);
  return (
    <div className="recipe-editor">
      {toolbar}
      <div className="recipe-table">
        <div className={`recipe-grid${n === 1 ? " single" : ""}`}>{recipe.cells.slice(0, n).map((v, i) => cell(`g:${i}`, v))}</div>
        <div className="recipe-arrow">→</div>
        <div className="recipe-result">
          {cell("result", recipe.result || null)}
          {countField(recipe.count, (c) => updateGame((r) => (r.count = c)))}
        </div>
      </div>

      {recipe.type === "smelting" && (
        <div className="recipe-furnace">
          <label>
            {t("Experience")}
            <input
              type="number"
              step={0.1}
              min={0}
              value={recipe.experience}
              disabled={readOnly}
              onChange={(e) => updateGame((r) => (r.experience = Math.max(0, Number(e.target.value) || 0)))}
            />
          </label>
          <label>
            {t("Cook time (ticks)")}
            <input
              type="number"
              min={1}
              value={recipe.cookTime}
              disabled={readOnly}
              onChange={(e) => updateGame((r) => (r.cookTime = Math.max(1, Math.round(Number(e.target.value)) || 200)))}
            />
          </label>
        </div>
      )}
      {picker}
      {error && <div className="recipe-error">{error}</div>}
    </div>
  );
}
