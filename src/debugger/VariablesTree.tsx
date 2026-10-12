import { useEffect, useRef, useState, type Dispatch, type MouseEvent, type ReactElement, type SetStateAction } from "react";
import { ContextMenu, useContextMenu, useKeybinding, useShell, useT, type ContextMenuItem } from "substrate-platform-ui";
import { canExpand, fetchChildren, type Variable } from "./variables";
import { useWatches } from "./WatchesContext";
import "./VariablesTree.css";

/** A top-level row: a local, a watch, or a DataTip's value. */
export interface RootRow {
  key: string;
  /** Shown in the Name column — a watch's expression, a local's name. */
  name: string;
  variable: Variable | null;
  /** Shown red in place of the value (a watch that doesn't evaluate). */
  error?: string | null;
}

export interface VariablesTreeProps {
  roots: RootRow[];
  /** DataTip layout: no header, no Type column. */
  compact?: boolean;
  /** Paths of expanded rows — pass to keep them across remounts (each stop); otherwise kept internally. */
  expanded?: ReadonlySet<string>;
  onExpandedChange?: Dispatch<SetStateAction<ReadonlySet<string>>>;
  /** Makes root names editable (Watch): called with the new text, empty to remove. */
  onEditRoot?: (index: number, text: string) => void;
  onDeleteRoot?: (index: number) => void;
  /** A trailing "add" row (Watch's "Add item to watch"). */
  onAdd?: (text: string) => void;
  /** Shown instead of rows when there are none (and no add row). */
  emptyText?: string;
}

/** A value the debugger couldn't produce (`yog-symbols` placeholders like `<optimized out>`), as opposed to a real one. */
const PLACEHOLDER = /^<[a-z ]+>$/;
/** Expanded under `root.key`, then each member's index and name — an index too, as shadowed or unnamed rows can repeat a name. */
const childPath = (parent: string, index: number, name: string) => `${parent}/${index}:${name}`;

interface MenuTarget {
  variable: Variable | null;
  /** The root's index, for a root row. */
  root: number | null;
  /** An expression for "Add Watch". */
  expr: string | null;
}

/**
 * Visual Studio's variable windows — Locals, Autos, Watch, a DataTip — as
 * a Name | Value | Type tree. Members of a big value are fetched only when
 * it's expanded (`handle`); what's expanded is remembered by path, so
 * stepping keeps the same members open. Right-click adds a row to Watch
 * or copies its value; values that failed show red.
 */
export function VariablesTree({ roots, compact, expanded: expandedProp, onExpandedChange, onEditRoot, onDeleteRoot, onAdd, emptyText }: VariablesTreeProps) {
  const t = useT();
  const watches = useWatches();
  const { showToolWindow } = useShell();
  const [ownExpanded, setOwnExpanded] = useState<ReadonlySet<string>>(new Set());
  const expanded = expandedProp ?? ownExpanded;
  const setExpanded = onExpandedChange ?? setOwnExpanded;
  const [selected, setSelected] = useState<string | null>(null);
  /** Root being renamed, or `"new"` for the add row. */
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menu = useContextMenu<MenuTarget>();

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const selectedRoot = selected === null ? -1 : roots.findIndex((r) => r.key === selected);
  const focused = () => !!containerRef.current?.contains(document.activeElement) && editing === null && selectedRoot >= 0;
  useKeybinding("Delete", () => onDeleteRoot?.(selectedRoot), { enabled: !!onDeleteRoot, when: focused });
  useKeybinding("F2", () => setEditing(selectedRoot), { enabled: !!onEditRoot, when: focused });

  const addWatch = (expr: string) => {
    watches.add(expr);
    showToolWindow("debug");
  };

  const menuItems = (target: MenuTarget): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    if (target.expr && !(target.root !== null && onDeleteRoot)) items.push({ label: t("Add Watch"), onSelect: () => addWatch(target.expr!) });
    if (target.root !== null && onEditRoot) items.push({ label: t("Edit Expression"), shortcut: "F2", onSelect: () => setEditing(target.root) });
    if (target.variable) {
      const value = target.variable.value;
      items.push({ label: t("Copy Value"), onSelect: () => void navigator.clipboard.writeText(value) });
    }
    if (target.root !== null && onDeleteRoot) {
      const index = target.root;
      items.push({ label: t("Delete Watch"), shortcut: "Delete", separatorBefore: items.length > 0, onSelect: () => onDeleteRoot(index) });
    }
    return items;
  };

  const rowProps = { compact: !!compact, expanded, toggle, selected, setSelected, openMenu: menu.openAtPoint };

  const rows: ReactElement[] = roots.map((root, index) => {
    const path = root.key;
    if (editing === index && onEditRoot) {
      return (
        <EditRow
          key={path}
          compact={!!compact}
          initial={root.name}
          onDone={(text) => {
            setEditing(null);
            if (text !== null && text !== root.name) onEditRoot(index, text);
          }}
        />
      );
    }
    return (
      <VariableRow
        key={path}
        {...rowProps}
        path={path}
        depth={0}
        name={root.name}
        variable={root.variable}
        error={root.error ?? null}
        menuTarget={{ variable: root.variable, root: index, expr: root.variable?.expr || root.name }}
        onDoubleClickName={onEditRoot ? () => setEditing(index) : undefined}
      />
    );
  });

  if (onAdd) {
    rows.push(
      editing === "new" ? (
        <EditRow
          key="\0new"
          compact={!!compact}
          initial=""
          onDone={(text) => {
            setEditing(null);
            if (text) onAdd(text);
          }}
        />
      ) : (
        <div key="\0new" className="yi-vt-row" onClick={() => setEditing("new")}>
          <div className="yi-vt-cell yi-vt-add">{t("Add item to watch")}</div>
          <div className="yi-vt-cell" />
          {!compact && <div className="yi-vt-cell" />}
        </div>
      ),
    );
  }

  if (rows.length === 0 && emptyText) return <div className="yi-vt-empty">{emptyText}</div>;

  return (
    <div ref={containerRef} tabIndex={-1} className={compact ? "yi-vt yi-vt--compact" : "yi-vt"}>
      {!compact && (
        <div className="yi-vt-row yi-vt-header">
          <div className="yi-vt-cell">{t("Name")}</div>
          <div className="yi-vt-cell">{t("Value")}</div>
          <div className="yi-vt-cell">{t("Type")}</div>
        </div>
      )}
      {rows}
      {menu.target && <ContextMenu target={menu.target} items={menuItems(menu.target.node)} onClose={menu.close} />}
    </div>
  );
}

interface RowProps {
  compact: boolean;
  expanded: ReadonlySet<string>;
  toggle: (path: string) => void;
  selected: string | null;
  setSelected: (path: string) => void;
  openMenu: (target: MenuTarget, e: MouseEvent) => void;
  path: string;
  depth: number;
  name: string;
  variable: Variable | null;
  error: string | null;
  menuTarget: MenuTarget;
  onDoubleClickName?: () => void;
}

/** One row and, when expanded, its members — fetched on first expansion when the backend handed out a `handle` instead of them. */
function VariableRow(props: RowProps) {
  const t = useT();
  const { compact, expanded, toggle, selected, setSelected, openMenu, path, depth, name, variable, error, menuTarget, onDoubleClickName } = props;
  const open = expanded.has(path);
  const expandable = !!variable && canExpand(variable);
  const members = useMembers(variable, open);

  const value = error ?? variable?.value ?? "";
  const valueClass = error ? "yi-vt-cell yi-vt-value yi-vt-error" : PLACEHOLDER.test(value) ? "yi-vt-cell yi-vt-value yi-vt-muted" : "yi-vt-cell yi-vt-value";
  const indent = { paddingLeft: `calc(var(--sp-space-xs) + ${depth * 14}px)` };

  return (
    <>
      <div
        className={selected === path ? "yi-vt-row yi-vt-selected" : "yi-vt-row"}
        onMouseDown={() => setSelected(path)}
        onContextMenu={(e) => {
          setSelected(path);
          openMenu(menuTarget, e);
        }}
      >
        <div className="yi-vt-cell" style={indent} title={name} onDoubleClick={onDoubleClickName}>
          <span
            className="yi-vt-twisty"
            onClick={(e) => {
              e.stopPropagation();
              if (expandable) toggle(path);
            }}
          >
            {expandable ? (open ? "▾" : "▸") : ""}
          </span>
          {name}
        </div>
        <div className={valueClass} title={value} onDoubleClick={() => expandable && toggle(path)}>
          {value}
        </div>
        {!compact && (
          <div className="yi-vt-cell yi-vt-muted" title={variable?.typeName}>
            {variable?.typeName}
          </div>
        )}
      </div>
      {open && expandable && members === "loading" && (
        <div className="yi-vt-row">
          <div className="yi-vt-cell yi-vt-muted" style={{ paddingLeft: `calc(var(--sp-space-xs) + ${(depth + 1) * 14 + 12}px)` }}>
            {t("Loading…")}
          </div>
          <div className="yi-vt-cell" />
          {!compact && <div className="yi-vt-cell" />}
        </div>
      )}
      {open && expandable && members !== null && typeof members === "object" && !Array.isArray(members) && (
        <div className="yi-vt-row">
          <div className="yi-vt-cell" />
          <div className="yi-vt-cell yi-vt-error" title={members.error}>
            {members.error}
          </div>
          {!compact && <div className="yi-vt-cell" />}
        </div>
      )}
      {open &&
        Array.isArray(members) &&
        members.map((child, i) => {
          const p = childPath(path, i, child.name);
          return (
            <VariableRow
              key={p}
              {...props}
              path={p}
              depth={depth + 1}
              name={child.name}
              variable={child}
              error={null}
              menuTarget={{ variable: child, root: null, expr: child.expr || null }}
              onDoubleClickName={undefined}
            />
          );
        })}
    </>
  );
}

/** A value's members: the ones it came with, or — once `open` — fetched through its `handle`. */
function useMembers(variable: Variable | null, open: boolean): Variable[] | "loading" | { error: string } | null {
  const [fetched, setFetched] = useState<{ handle: number; result: Variable[] | { error: string } } | null>(null);
  const handle = variable && variable.children.length === 0 ? (variable.handle ?? null) : null;
  useEffect(() => {
    if (!open || handle === null || fetched?.handle === handle) return;
    let current = true;
    fetchChildren(handle)
      .then((members) => current && setFetched({ handle, result: members }))
      .catch((err) => current && setFetched({ handle, result: { error: String(err) } }));
    return () => {
      current = false;
    };
  }, [open, handle, fetched?.handle]);
  if (!variable) return null;
  if (variable.children.length > 0) return variable.children;
  if (handle === null) return [];
  return fetched?.handle === handle ? fetched.result : "loading";
}

/** A Name cell turned into a text box — renaming a watch or adding one. Enter commits, Escape or an empty box cancels. */
function EditRow({ compact, initial, onDone }: { compact: boolean; initial: string; onDone: (text: string | null) => void }) {
  const done = useRef(false);
  const finish = (text: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(text);
  };
  return (
    <div className="yi-vt-row">
      <div className="yi-vt-cell yi-vt-edit">
        <input
          autoFocus
          defaultValue={initial}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter") finish(e.currentTarget.value.trim());
            else if (e.key === "Escape") finish(null);
          }}
          onBlur={(e) => finish(e.currentTarget.value.trim())}
        />
      </div>
      <div className="yi-vt-cell" />
      {!compact && <div className="yi-vt-cell" />}
    </div>
  );
}
