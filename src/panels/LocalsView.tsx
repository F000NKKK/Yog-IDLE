import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useT } from "substrate-platform-ui";

/** One row of the Locals view, as `debug_variables` (debugger.rs `VariableOut`) returns it. */
interface Variable {
  name: string;
  typeName: string;
  value: string;
  children: Variable[];
}

const mono: CSSProperties = { fontFamily: "var(--sp-font-mono)", fontSize: "12px" };
/** A value the debugger couldn't produce (`yog-symbols` placeholders), as opposed to a real one. */
const PLACEHOLDER = /^<[a-z ]+>$/;
const cell: CSSProperties ={ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", padding: "1px var(--sp-space-xs)" };

/**
 * Visual Studio's Locals window: the selected frame's parameters and
 * variables as a name | value | type tree. Re-queried on every stop and
 * frame switch (`stopKey`); what's expanded is remembered by path, so
 * stepping keeps the same members open.
 */
export function LocalsView({ stopKey, frame }: { stopKey: unknown; frame: number | null }) {
  const t = useT();
  const [vars, setVars] = useState<Variable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (frame === null) {
      setVars([]);
      setError(null);
      return;
    }
    let current = true;
    invoke<Variable[]>("debug_variables", { frame })
      .then((v) => {
        if (!current) return;
        setVars(v);
        setError(null);
      })
      .catch((err) => {
        if (!current) return;
        setVars(null);
        setError(String(err));
      });
    return () => {
      current = false;
    };
  }, [stopKey, frame]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  if (error) return <div style={{ ...mono, padding: "2px var(--sp-space-sm)", color: "var(--sp-text-muted)" }}>{error}</div>;
  if (!vars) return <div style={{ ...mono, padding: "2px var(--sp-space-sm)", color: "var(--sp-text-muted)" }}>{t("Loading…")}</div>;
  if (vars.length === 0) return <div style={{ ...mono, padding: "2px var(--sp-space-sm)", color: "var(--sp-text-muted)" }}>{t("No locals in this frame.")}</div>;

  const rows: ReactElement[] = [];
  const walk = (list: Variable[], depth: number, parent: string) => {
    list.forEach((v, i) => {
      // Index too: shadowed or unnamed rows (`[0]`, tuple fields) can repeat a name.
      const path = `${parent}/${i}:${v.name}`;
      const open = expanded.has(path);
      const hasChildren = v.children.length > 0;
      rows.push(
        <div key={path} style={{ display: "contents" }}>
          <div
            onClick={() => hasChildren && toggle(path)}
            title={v.name}
            style={{ ...cell, paddingLeft: `calc(var(--sp-space-xs) + ${depth * 14}px)`, cursor: hasChildren ? "pointer" : "default" }}
          >
            <span style={{ display: "inline-block", width: 12, color: "var(--sp-text-muted)" }}>{hasChildren ? (open ? "▾" : "▸") : ""}</span>
            {v.name}
          </div>
          <div
            title={v.value}
            // `<not in scope>`, `<optimized out>`, `<unavailable>`...: no value, so dim it.
            style={{ ...cell, userSelect: "text", ...(PLACEHOLDER.test(v.value) ? { color: "var(--sp-text-muted)" } : {}) }}
          >
            {v.value}
          </div>
          <div title={v.typeName} style={{ ...cell, color: "var(--sp-text-muted)" }}>
            {v.typeName}
          </div>
        </div>,
      );
      if (open) walk(v.children, depth + 1, path);
    });
  };
  walk(vars, 0, "");

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(80px, 1fr) minmax(80px, 2fr) minmax(60px, 1fr)", ...mono }}>
      <div style={{ ...cell, color: "var(--sp-text-muted)" }}>{t("Name")}</div>
      <div style={{ ...cell, color: "var(--sp-text-muted)" }}>{t("Value")}</div>
      <div style={{ ...cell, color: "var(--sp-text-muted)" }}>{t("Type")}</div>
      {rows}
    </div>
  );
}
