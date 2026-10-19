// The resource editor's cell editors: text, color and type, committed and
// moved through with the keyboard.

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useT } from "substrate-platform-ui";
import { RESOURCE_TYPES, type ResourceType } from "../../lang/yres";
import { ALPHA_SHIFT, cssColor, hex, OPAQUE, rgbOf, TYPE_LABELS } from "./yresModel";

// ── Cell editors ─────────────────────────────────────────────────────────────

export type Commit = (value: string, move?: "down" | "next" | "prev") => void;

/** Ends an edit as soon as it starts — a cell that toggles (a flag) or can't be edited. */
export function ImmediateCommit({ run }: { run: () => void }) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    run();
  });
  return null;
}

/** Enter/Tab/Esc as the grid's own editor handles them. */
export function editKeys(e: KeyboardEvent<HTMLElement>, value: () => string, commit: Commit, cancel: () => void) {
  e.stopPropagation();
  if (e.key === "Enter") {
    e.preventDefault();
    commit(value(), "down");
  } else if (e.key === "Tab") {
    e.preventDefault();
    commit(value(), e.shiftKey ? "prev" : "next");
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancel();
  }
}

/** A text input in a cell, optionally with a "…" browse button. */
export function CellInput({
  value,
  initial,
  commit,
  cancel,
  browse,
  browseTitle,
}: {
  value: string;
  initial?: string;
  commit: Commit;
  cancel: () => void;
  browse?: () => Promise<string | null>;
  browseTitle?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const browsing = useRef(false);
  return (
    <span className="yres-cell-edit" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        className="sp-datagrid-cell-editor"
        autoFocus
        defaultValue={initial ?? value}
        onFocus={(e) => {
          const end = e.currentTarget.value.length;
          if (initial !== undefined) e.currentTarget.setSelectionRange(end, end);
          else e.currentTarget.select();
        }}
        onBlur={(e) => {
          if (!browsing.current) commit(e.target.value);
        }}
        onKeyDown={(e) => editKeys(e, () => ref.current?.value ?? "", commit, cancel)}
      />
      {browse && (
        <button
          type="button"
          className="yres-browse"
          title={browseTitle}
          onMouseDown={(e) => {
            // Keep the input from committing on blur while the dialog is up.
            e.preventDefault();
            browsing.current = true;
          }}
          onClick={async () => {
            const picked = await browse();
            browsing.current = false;
            if (picked !== null) commit(picked);
            else ref.current?.focus();
          }}
        >
          …
        </button>
      )}
    </span>
  );
}

/** A `#AARRGGBB` text with a color picker next to it (the picker keeps the alpha). */
export function ColorEdit({ value, argb, initial, commit, cancel }: { value: string; argb?: number; initial?: string; commit: Commit; cancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const picking = useRef(false);
  const [text, setText] = useState(initial ?? value);
  // The color as last read or picked; typed text is checked by the CLI when it's committed.
  const [shown, setShown] = useState(argb);
  return (
    <span className="yres-cell-edit" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <span className="yres-swatch" style={{ background: cssColor(shown) }} />
      <input
        ref={ref}
        className="sp-datagrid-cell-editor yres-mono"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => {
          if (initial === undefined) e.currentTarget.select();
        }}
        onBlur={() => {
          if (!picking.current) commit(text.trim().toUpperCase());
        }}
        onKeyDown={(e) => editKeys(e, () => text.trim().toUpperCase(), commit, cancel)}
      />
      <input
        type="color"
        className="yres-color-input"
        value={rgbOf(shown)}
        onMouseDown={() => {
          picking.current = true;
        }}
        onChange={(e) => {
          const alpha = shown === undefined ? OPAQUE : shown >>> ALPHA_SHIFT;
          const next = ((alpha << ALPHA_SHIFT) | parseInt(e.target.value.slice(1), 16)) >>> 0;
          setShown(next);
          setText(`#${hex(next, 8)}`.toUpperCase());
        }}
        onBlur={() => {
          picking.current = false;
          ref.current?.focus();
        }}
      />
    </span>
  );
}

export function TypeSelect({ value, commit, cancel }: { value: ResourceType; commit: Commit; cancel: () => void }) {
  const t = useT();
  return (
    <select
      className="sp-datagrid-cell-editor yres-type-select"
      autoFocus
      defaultValue={value}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => commit(e.target.value)}
      onBlur={cancel}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Enter" || e.key === "Tab") editKeys(e, () => e.currentTarget.value, commit, cancel);
        else e.stopPropagation();
      }}
    >
      {RESOURCE_TYPES.map((type) => (
        <option key={type} value={type}>
          {t(TYPE_LABELS[type])}
        </option>
      ))}
    </select>
  );
}
