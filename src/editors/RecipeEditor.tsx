import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useT, type EditorProps } from "substrate-platform-ui";
import { imagePreview, imageSources, imageSourcesVersion, subscribeImageSources } from "../designer/imageSources";
import { cellCount, emptyRecipe, parseRecipe, serializeRecipe, type Recipe, type RecipeType } from "./recipeModel";
import "./RecipeEditor.css";

/** The code view of a `.yrecipe` (registered in `editors/index.tsx`). */
export const RECIPE_SOURCE_VIEW = "yog.recipe.source";

const TYPES: RecipeType[] = ["shaped", "shapeless", "smelting"];
/** Which cell the picker edits: a grid cell, or the result. */
type Target = number | "result";

/**
 * `.yrecipe` files, as a crafting table: the grid (or a furnace's one
 * slot), the result and its count. Pick a cell, then an item — typed with
 * its namespace (`minecraft:paper`) or a tag (`#c:dusts`), with the game's
 * and the mod's items offered as you type.
 */
export function RecipeEditor({ path, content, onChange, readOnly }: EditorProps) {
  const t = useT();
  useSyncExternalStore(subscribeImageSources, imageSourcesVersion);
  const parsed = useMemo(() => parseRecipe(content), [content]);
  const recipe = parsed ?? emptyRecipe();
  const [target, setTarget] = useState<Target>(0);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const current = target === "result" ? recipe.result : (recipe.cells[target] ?? "");
  useEffect(() => setDraft(current), [current, target]);

  const update = useCallback(
    (change: (r: Recipe) => void) => {
      if (readOnly) return;
      const next: Recipe = { ...recipe, cells: [...recipe.cells], extra: { ...recipe.extra } };
      change(next);
      const text = serializeRecipe(next);
      if (text !== content) onChange(text);
    },
    [recipe, content, onChange, readOnly]
  );

  const commit = (value: string) => {
    const v = value.trim();
    update((r) => {
      if (target === "result") r.result = v;
      else r.cells[target] = v || null;
    });
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

  if (!parsed && content.trim() !== "") {
    return <div className="recipe-editor recipe-error">{t("This isn't a recipe (a JSON object) — fix it in the Code view.")}</div>;
  }

  const cell = (i: Target, value: string | null) => {
    const icon = value && !value.startsWith("#") ? imagePreview(path, `item:${value}`) : null;
    return (
      <button
        key={String(i)}
        type="button"
        className={`recipe-cell${target === i ? " selected" : ""}`}
        title={value ?? t("Empty")}
        onClick={() => {
          setTarget(i);
          inputRef.current?.focus();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setTarget(i);
          update((r) => {
            if (i === "result") r.result = "";
            else r.cells[i] = null;
          });
        }}
      >
        {icon ? <img src={icon} alt="" /> : value ? <span className="recipe-cell-text">{value.split(":").pop()}</span> : null}
      </button>
    );
  };

  const n = cellCount(recipe.type);
  return (
    <div className="recipe-editor">
      <div className="recipe-toolbar">
        {TYPES.map((ty) => (
          <button
            key={ty}
            type="button"
            className={`recipe-type${recipe.type === ty ? " active" : ""}`}
            disabled={readOnly}
            onClick={() => update((r) => (r.type = ty))}
          >
            {t(ty === "shaped" ? "Shaped" : ty === "shapeless" ? "Shapeless" : "Smelting")}
          </button>
        ))}
      </div>

      <div className="recipe-table">
        <div className={`recipe-grid${n === 1 ? " single" : ""}`}>{recipe.cells.slice(0, n).map((v, i) => cell(i, v))}</div>
        <div className="recipe-arrow">→</div>
        <div className="recipe-result">
          {cell("result", recipe.result || null)}
          <label>
            {t("Count")}
            <input
              type="number"
              min={1}
              max={64}
              value={recipe.count}
              disabled={readOnly}
              onChange={(e) => update((r) => (r.count = Math.max(1, Math.min(64, Number(e.target.value) || 1))))}
            />
          </label>
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
              onChange={(e) => update((r) => (r.experience = Math.max(0, Number(e.target.value) || 0)))}
            />
          </label>
          <label>
            {t("Cook time (ticks)")}
            <input
              type="number"
              min={1}
              value={recipe.cookTime}
              disabled={readOnly}
              onChange={(e) => update((r) => (r.cookTime = Math.max(1, Math.round(Number(e.target.value)) || 200)))}
            />
          </label>
        </div>
      )}

      <div className="recipe-picker">
        <span>{target === "result" ? t("Result") : t("Ingredient {n}", { n: target + 1 })}</span>
        <input
          ref={inputRef}
          list="recipe-items"
          value={draft}
          disabled={readOnly}
          placeholder={target === "result" ? "minecraft:paper" : "minecraft:paper / #c:dusts"}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => e.key === "Enter" && commit(draft)}
        />
        <datalist id="recipe-items">
          {items.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <span className="recipe-hint">{t("Right-click a cell to empty it.")}</span>
      </div>
    </div>
  );
}
