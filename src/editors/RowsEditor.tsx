import { useId, type ReactNode } from "react";
import { Icon, IconButton, SelectField, TextField, useT } from "substrate-platform-ui";
import "./designers.css";

/** One column of a `RowsEditor`: a field of each object. */
export type Column<R> = {
  key: keyof R & string;
  /** Its name, translated by the caller (a tooltip and the header). */
  label: string;
  /** How wide, relative to the others (default 1). */
  grow?: number;
} & (
  | { kind: "text"; suggestions?: readonly string[]; validate?: (v: string) => string | null }
  | { kind: "number"; min?: number; max?: number; int?: boolean; placeholder?: string }
  | { kind: "enum"; options: readonly { value: string; label: string }[] }
);

/**
 * A list of objects edited in the inspector, a row each and a field a
 * column — an effect's modifiers, a potion's effects, a tree's blocks;
 * `lead`/`trail` draw something before/after a row (an icon, a share), a
 * row removed, one added with `blank`. Typed fields commit on Enter or
 * when left; an empty optional number removes the field.
 */
export function RowsEditor<R extends Record<string, unknown>>({
  rows,
  columns,
  onChange,
  blank,
  readOnly,
  lead,
  trail,
}: {
  rows: readonly R[];
  columns: readonly Column<R>[];
  onChange: (rows: R[]) => void;
  blank: () => R;
  readOnly?: boolean;
  lead?: (row: R, i: number) => ReactNode;
  trail?: (row: R, i: number) => ReactNode;
}) {
  const t = useT();
  const id = useId();
  const set = (i: number, key: string, v: unknown) =>
    onChange(
      rows.map((r, j) => {
        if (j !== i) return r;
        const next = { ...r } as Record<string, unknown>;
        if (v === undefined) delete next[key];
        else next[key] = v;
        return next as R;
      }),
    );
  return (
    <div className="rows-editor">
      {rows.length > 0 && (
        <div className="rows-row is-head">
          {lead && <span className="rows-lead" />}
          {columns.map((c) => (
            <span key={c.key} className="rows-cell" style={{ flexGrow: c.grow ?? 1 }} title={c.label}>
              {c.label}
            </span>
          ))}
          {trail && <span className="rows-trail" />}
          {!readOnly && <span className="rows-remove" />}
        </div>
      )}
      {rows.map((r, i) => (
        <div key={i} className="rows-row">
          {lead && <span className="rows-lead">{lead(r, i)}</span>}
          {columns.map((c) => {
            const v = r[c.key];
            const cell = { flexGrow: c.grow ?? 1 };
            if (c.kind === "enum")
              return (
                <span key={c.key} className="rows-cell" style={cell}>
                  <SelectField value={String(v ?? "")} disabled={readOnly} options={c.options} onChange={(x) => set(i, c.key, x)} aria-label={c.label} />
                </span>
              );
            const text = v === undefined || v === null ? "" : String(v);
            const problem =
              c.kind === "text"
                ? (c.validate?.(text) ?? null)
                : text !== "" && (Number.isNaN(Number(text)) || (c.min !== undefined && Number(text) < c.min) || (c.max !== undefined && Number(text) > c.max))
                  ? t("Between {min} and {max}.", { min: c.min ?? "-∞", max: c.max ?? "∞" })
                  : null;
            const commit = (s: string) => {
              const x = s.trim();
              if (x === text) return;
              if (c.kind === "text") return set(i, c.key, x || undefined);
              const n = Number(x);
              if (x === "") return set(i, c.key, undefined);
              if (Number.isNaN(n)) return;
              set(i, c.key, c.int ? Math.round(n) : n);
            };
            return (
              <span key={c.key} className="rows-cell" style={cell}>
                <TextField
                  key={text}
                  defaultValue={text}
                  disabled={readOnly}
                  list={c.kind === "text" && c.suggestions ? `${id}-${c.key}` : undefined}
                  placeholder={c.kind === "number" ? c.placeholder : undefined}
                  className={problem ? "is-invalid" : undefined}
                  title={problem ?? text}
                  aria-label={c.label}
                  onBlur={(e) => commit(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    e.stopPropagation();
                  }}
                />
              </span>
            );
          })}
          {trail && <span className="rows-trail">{trail(r, i)}</span>}
          {!readOnly && (
            <IconButton size="sm" className="rows-remove" title={t("Remove")} aria-label={t("Remove")} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              <Icon name="trash" size={12} />
            </IconButton>
          )}
        </div>
      ))}
      {columns.map(
        (c) =>
          c.kind === "text" &&
          c.suggestions && (
            <datalist key={c.key} id={`${id}-${c.key}`}>
              {c.suggestions.slice(0, 500).map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          ),
      )}
      {!readOnly && (
        <div>
          <IconButton size="sm" title={t("Add")} aria-label={t("Add")} onClick={() => onChange([...rows, blank()])}>
            <Icon name="plus" size={12} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
