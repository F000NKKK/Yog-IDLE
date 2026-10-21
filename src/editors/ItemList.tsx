import { useState, type ReactNode } from "react";
import { Icon, IconButton, TextField, useT } from "substrate-platform-ui";
import "./designers.css";

export interface ItemListProps {
  items: readonly string[];
  /** The whole new list. */
  onChange: (items: string[]) => void;
  /** Offered while typing a new item (any other text is checked by `validate`). */
  suggestions?: readonly string[];
  /** Why an item can't be added (`null`: it can). */
  validate?: (item: string) => string | null;
  /** Drawn before an item (its icon). */
  lead?: (item: string) => ReactNode;
  /** Its text as shown (default the item). */
  label?: (item: string) => string;
  /** Items keep an order that matters (goals by priority): ▲▼ move them. */
  ordered?: boolean;
  placeholder?: string;
  readOnly?: boolean;
  /** A row picked (the inspector shows it). */
  onPick?: (index: number) => void;
  picked?: number | null;
}

/**
 * A list the designers edit in their inspector: what's in a tag, a mob's
 * goals, the tables a loot modifier changes — each item with its icon,
 * moved up and down when the order matters, removed; one added from the
 * suggestions or typed, checked first.
 */
export function ItemList({ items, onChange, suggestions, validate, lead, label, ordered, placeholder, readOnly, onPick, picked }: ItemListProps) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    const problem = validate?.(v) ?? null;
    setError(problem);
    if (problem) return;
    onChange([...items, v]);
    setDraft("");
  };
  const move = (i: number, d: number) => {
    const next = [...items];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    onChange(next);
  };
  return (
    <div className="item-list">
      {items.map((item, i) => (
        <div key={`${i}:${item}`} className={`item-list-row${picked === i ? " is-picked" : ""}${onPick ? " is-pickable" : ""}`} onClick={onPick ? () => onPick(i) : undefined}>
          {lead && <span className="item-list-lead">{lead(item)}</span>}
          <span className="item-list-text" title={item}>
            {label ? label(item) : item}
          </span>
          {!readOnly && ordered && (
            <>
              <IconButton size="sm" title={t("Move Up")} aria-label={t("Move Up")} disabled={i === 0} onClick={(e) => (e.stopPropagation(), move(i, -1))}>
                <Icon name="arrowUp" size={12} />
              </IconButton>
              <IconButton size="sm" title={t("Move Down")} aria-label={t("Move Down")} disabled={i === items.length - 1} onClick={(e) => (e.stopPropagation(), move(i, 1))}>
                <Icon name="arrowDown" size={12} />
              </IconButton>
            </>
          )}
          {!readOnly && (
            <IconButton size="sm" title={t("Remove")} aria-label={t("Remove")} onClick={(e) => (e.stopPropagation(), onChange(items.filter((_, j) => j !== i)))}>
              <Icon name="trash" size={12} />
            </IconButton>
          )}
        </div>
      ))}
      {!readOnly && (
        <div className="item-list-add">
          <TextField
            suggestions={suggestions?.filter((s) => !items.includes(s))}
            value={draft}
            placeholder={placeholder ?? t("Add…")}
            onChange={(e) => (setDraft(e.target.value), setError(null))}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
              else if (e.key === "Escape") setDraft("");
              e.stopPropagation();
            }}
          />
          <IconButton size="sm" title={t("Add")} aria-label={t("Add")} disabled={!draft.trim()} onClick={add}>
            <Icon name="plus" size={12} />
          </IconButton>
        </div>
      )}
      {error && <div className="item-list-error">{error}</div>}
    </div>
  );
}
