import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Button,
  DataGrid,
  Icon,
  IconButton,
  SearchField,
  notifyDocumentCommands,
  promptDialog,
  registerDocumentCommands,
  tn,
  useKeybinding,
  useLocale,
  useT,
  type DataGridColumn,
  type DataGridHandle,
  type DirEntry,
  type EditorProps,
} from "substrate-platform-ui";
import { useOpenFiles } from "../OpenFilesContext";
import { reportError } from "../reportError";
import {
  isLocaleName,
  parseYlang,
  REFERENCE_LOCALE,
  serializeYlang,
  splitYlangPath,
  valueMap,
  type YlangEntry,
} from "../lang/ylang";
import "./YlangEditor.css";

/** Another `<locale>.ylang` in the same folder — an extra column of the multi-language view. */
interface Sibling {
  locale: string;
  path: string;
  /** `null` when it doesn't parse — shown, but not editable here. */
  entries: YlangEntry[] | null;
  values: Map<string, string>;
}

/** One grid row: an entry of this file (or the empty "new row" at the end). */
interface Row {
  id: string;
  /** Index in this file's entries; -1 for the new row. */
  index: number;
  key: string;
  value: string;
  comment: string;
  isNew?: boolean;
}

const NEW_ROW_ID = "__new__";
const LOCALE_COLUMN = "loc:";
const SHOW_ALL_KEY = "yog.ylang.showAllLanguages";

/** Tab-separated rows for the clipboard; tabs, newlines and backslashes escaped. */
function escapeCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r?\n/g, "\\n");
}

function unescapeCell(text: string): string {
  return text.replace(/\\(.)/g, (_, c: string) => (c === "t" ? "\t" : c === "n" ? "\n" : c));
}

/**
 * The `.ylang` designer, like Visual Studio's ResX editor: Name | Value |
 * Comment in a grid, edited in place, and — with "All Languages" — every
 * sibling `<locale>.ylang` of the folder as another Value column, missing
 * translations marked (VS 2022's multi-language resource view). Edits of
 * this file go through `onChange` (dirty state, Save, undo/redo); edits of
 * another locale's column go to that file — to its open tab if it has one,
 * straight to disk otherwise. The file is rewritten formatted on every edit:
 * 2-space indent, key order kept, comments kept.
 */
export function YlangEditor({ path, content, onChange, readOnly, contentVersion }: EditorProps) {
  const t = useT();
  const locale = useLocale();
  const { tabs, updateContent, setView } = useOpenFiles();
  const parsed = useMemo(() => parseYlang(content), [content]);
  const entries = useMemo(() => (parsed.ok ? parsed.entries : []), [parsed]);
  const { dir, locale: ownLocale, sep } = splitYlangPath(path);

  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(() => localStorage.getItem(SHOW_ALL_KEY) === "1");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [siblings, setSiblings] = useState<Sibling[]>([]);
  const gridRef = useRef<DataGridHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** The row/column the grid's keyboard focus was last on — where a single-value paste goes. */
  const activeRef = useRef<{ row: Row | null; column: string | null }>({ row: null, column: null });

  // ── Undo/redo over this file's text ───────────────────────────────────────

  const contentRef = useRef(content);
  contentRef.current = content;
  const history = useRef<{ past: string[]; future: string[] }>({ past: [], future: [] });
  useEffect(() => {
    // Reloaded from disk (or replaced by the Code view): old steps no longer apply.
    history.current = { past: [], future: [] };
    notifyDocumentCommands();
  }, [contentVersion]);

  const apply = useCallback(
    (next: YlangEntry[]) => {
      if (readOnly) return;
      const text = serializeYlang(next);
      if (text === contentRef.current) return;
      history.current.past.push(contentRef.current);
      history.current.future = [];
      onChange(text);
      notifyDocumentCommands();
    },
    [onChange, readOnly]
  );

  const step = useCallback(
    (back: boolean) => {
      const h = history.current;
      const from = back ? h.past : h.future;
      const to = back ? h.future : h.past;
      const text = from.pop();
      if (text === undefined || readOnly) return;
      to.push(contentRef.current);
      onChange(text);
      notifyDocumentCommands();
    },
    [onChange, readOnly]
  );

  // ── Sibling locales ──────────────────────────────────────────────────────

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const loadSiblings = useCallback(async () => {
    let list: DirEntry[];
    try {
      list = await invoke<DirEntry[]>("dir_list", { path: dir });
    } catch {
      return;
    }
    const files = list.filter((e) => e.kind === "file" && /\.ylang$/i.test(e.name) && e.path !== path);
    const loaded = await Promise.all(
      files.map(async (file): Promise<Sibling | null> => {
        const open = tabsRef.current.find((tab) => tab.path === file.path && tab.textLoaded);
        let text: string;
        try {
          text = open ? open.content : await invoke<string>("file_read", { path: file.path });
        } catch {
          return null;
        }
        const result = parseYlang(text);
        const entries = result.ok ? result.entries : null;
        return { locale: splitYlangPath(file.path).locale, path: file.path, entries, values: valueMap(entries ?? []) };
      })
    );
    setSiblings(
      loaded
        .filter((s): s is Sibling => !!s)
        // en_us first, the rest by name — VS puts the neutral language first.
        .sort((a, b) => (a.locale === REFERENCE_LOCALE ? -1 : b.locale === REFERENCE_LOCALE ? 1 : a.locale.localeCompare(b.locale)))
    );
  }, [dir, path]);

  useEffect(() => {
    void loadSiblings();
    const onFocus = () => void loadSiblings();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadSiblings, showAll]);

  /** Writes another locale's file: into its open tab (left unsaved, like any edit) or straight to disk. */
  const writeSibling = useCallback(
    async (sibling: Sibling, next: YlangEntry[]) => {
      const text = serializeYlang(next);
      const open = tabsRef.current.find((tab) => tab.path === sibling.path && tab.textLoaded);
      if (open) updateContent(open.id, text);
      else {
        try {
          await invoke("file_write", { path: sibling.path, contents: text });
        } catch (err) {
          reportError(t("Failed to save {path}: {error}", { path: sibling.path, error: String(err) }));
          return;
        }
      }
      setSiblings((prev) => prev.map((s) => (s.path === sibling.path ? { ...s, entries: next, values: valueMap(next) } : s)));
    },
    [t, updateContent]
  );

  const reference = !showAll && ownLocale !== REFERENCE_LOCALE ? siblings.find((s) => s.locale === REFERENCE_LOCALE) : undefined;
  const shownSiblings = showAll ? siblings : reference ? [reference] : [];

  // ── Rows and validation ─────────────────────────────────────────────────

  const keyCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.key, (counts.get(e.key) ?? 0) + 1);
    return counts;
  }, [entries]);

  const rows = useMemo<Row[]>(() => {
    const all = entries.map((e, index) => ({ id: `r${index}`, index, key: e.key, value: e.value, comment: e.comment ?? "" }));
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (r) =>
        [r.key, r.value, r.comment].some((s) => s.toLowerCase().includes(needle)) ||
        shownSiblings.some((s) => s.values.get(r.key)?.toLowerCase().includes(needle))
    );
  }, [entries, query, shownSiblings]);

  const newRow = useMemo<Row[]>(
    () => (readOnly ? [] : [{ id: NEW_ROW_ID, index: -1, key: "", value: "", comment: "", isNew: true }]),
    [readOnly]
  );

  const keyProblem = (row: Row): string | undefined => {
    if (row.isNew) return undefined;
    if (row.key.trim() === "") return t("The name can't be empty.");
    if ((keyCounts.get(row.key) ?? 0) > 1) return t("Another resource has the same name.");
    return undefined;
  };

  const missingIn = (row: Row): string[] =>
    shownSiblings.filter((s) => s.entries && !s.values.get(row.key)).map((s) => s.locale);

  const errors = entries.reduce(
    (n, e, index) => n + (keyProblem({ id: "", index, key: e.key, value: e.value, comment: "" }) ? 1 : 0),
    0
  );
  const missing = showAll ? entries.reduce((n, e) => n + siblings.filter((s) => s.entries && !s.values.get(e.key)).length, 0) : 0;

  // ── Edits ────────────────────────────────────────────────────────────────

  function renameInSiblings(from: string, to: string) {
    for (const s of siblings) {
      if (!s.entries || !s.values.has(from) || s.values.has(to)) continue;
      void writeSibling(
        s,
        s.entries.map((e) => (e.key === from ? { ...e, key: to } : e))
      );
    }
  }

  function commitCell(row: Row, column: string, text: string) {
    if (readOnly) return;
    if (column.startsWith(LOCALE_COLUMN)) {
      const sibling = siblings.find((s) => s.locale === column.slice(LOCALE_COLUMN.length));
      if (!sibling?.entries || row.isNew || (sibling.values.get(row.key) ?? "") === text) return;
      const has = sibling.entries.some((e) => e.key === row.key);
      void writeSibling(
        sibling,
        has ? sibling.entries.map((e) => (e.key === row.key ? { ...e, value: text } : e)) : [...sibling.entries, { key: row.key, value: text }]
      );
      return;
    }
    if (row.isNew) {
      if (text === "") return;
      const created: YlangEntry = { key: "", value: "" };
      if (column === "key") created.key = text.trim();
      else if (column === "value") created.value = text;
      else if (column === "comment") created.comment = text;
      apply([...entries, created]);
      return;
    }
    const entry = entries[row.index];
    if (!entry) return;
    let next: YlangEntry;
    if (column === "key") {
      const key = text.trim();
      if (key === entry.key) return;
      next = { ...entry, key };
      if (showAll && key !== "" && !keyCounts.has(key)) renameInSiblings(entry.key, key);
    } else if (column === "value") {
      if (text === entry.value) return;
      next = { ...entry, value: text };
    } else if (column === "comment") {
      if (text === (entry.comment ?? "")) return;
      next = { ...entry, comment: text || undefined };
      if (!text) delete next.comment;
    } else return;
    apply(entries.map((e, i) => (i === row.index ? next : e)));
  }

  /** The rows Delete/Copy act on: the selection, else the row with keyboard focus. */
  function targetRows(): Row[] {
    const picked = rows.filter((r) => selected.has(r.id));
    if (picked.length > 0) return picked;
    const active = activeRef.current.row;
    return active && !active.isNew ? [active] : [];
  }

  function deleteRows() {
    const doomed = targetRows();
    if (readOnly || doomed.length === 0) return;
    const drop = new Set(doomed.map((r) => r.index));
    const remaining = entries.filter((_, i) => !drop.has(i));
    apply(remaining);
    if (showAll) {
      // As in VS's multi-language view: a resource removed goes from every language.
      const gone = new Set(doomed.map((r) => r.key).filter((key) => !remaining.some((e) => e.key === key)));
      for (const s of siblings) {
        if (s.entries?.some((e) => gone.has(e.key))) void writeSibling(s, s.entries.filter((e) => !gone.has(e.key)));
      }
    }
    setSelected(new Set());
  }

  function copyRows(): boolean {
    const picked = targetRows();
    if (picked.length === 0) return false;
    const text = picked.map((r) => [r.key, r.value, r.comment].map(escapeCell).join("\t")).join("\n");
    void navigator.clipboard.writeText(text).catch(() => {});
    return true;
  }

  async function paste() {
    if (readOnly) return;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
    // One plain value: into the active cell, as a spreadsheet does.
    if (lines.length === 1 && !lines[0].includes("\t")) {
      const { row, column } = activeRef.current;
      if (row && column) commitCell(row, column, lines[0]);
      return;
    }
    const next = [...entries];
    for (const line of lines) {
      const [key = "", value = "", comment = ""] = line.split("\t").map(unescapeCell);
      if (!key.trim()) continue;
      const at = next.findIndex((e) => e.key === key.trim());
      const entry: YlangEntry = comment ? { key: key.trim(), value, comment } : { key: key.trim(), value };
      if (at >= 0) next[at] = comment ? entry : { ...entry, comment: next[at].comment };
      else next.push(entry);
    }
    apply(next.map((e) => (e.comment === undefined ? { key: e.key, value: e.value } : e)));
  }

  async function addLanguage() {
    const taken = new Set([ownLocale, ...siblings.map((s) => s.locale)]);
    const name = await promptDialog({
      title: t("Add Language"),
      message: t("A new {file} next to this one, with every resource of this file left to translate.", { file: "<locale>.ylang" }),
      label: t("Locale"),
      placeholder: "ru_ru",
      confirmLabel: t("Add"),
      validate: (value) => {
        const v = value.trim().toLowerCase();
        if (!v) return "";
        if (!isLocaleName(v)) return t("A Minecraft locale code, like en_us, ru_ru or pt_br.");
        if (taken.has(v)) return t("This folder already has {name}.", { name: `${v}.ylang` });
        return null;
      },
    });
    if (!name) return;
    const target = `${dir}${sep}${name.trim().toLowerCase()}.ylang`;
    const seen = new Set<string>();
    const keys = entries.filter((e) => e.key && !seen.has(e.key) && seen.add(e.key)).map((e) => ({ key: e.key, value: "" }));
    try {
      await invoke("file_write", { path: target, contents: serializeYlang(keys) });
    } catch (err) {
      reportError(t("Failed to save {path}: {error}", { path: target, error: String(err) }));
      return;
    }
    setShowAll(true);
    localStorage.setItem(SHOW_ALL_KEY, "1");
    void loadSiblings();
  }

  function toggleShowAll() {
    setShowAll((v) => {
      localStorage.setItem(SHOW_ALL_KEY, v ? "0" : "1");
      return !v;
    });
  }

  // ── Keyboard and Edit menu ──────────────────────────────────────────────

  const gridFocused = () => {
    const el = document.activeElement;
    return !!rootRef.current && !!el && rootRef.current.contains(el) && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement);
  };
  const editable = () => !readOnly && gridFocused();
  const commands = useRef({ deleteRows, copyRows, paste, step });
  commands.current = { deleteRows, copyRows, paste, step };

  useKeybinding("Delete", () => commands.current.deleteRows(), { when: editable });
  useKeybinding("Ctrl+C", () => void commands.current.copyRows(), { when: gridFocused });
  useKeybinding("Ctrl+X", () => void (commands.current.copyRows() && commands.current.deleteRows()), { when: editable });
  useKeybinding("Ctrl+V", () => void commands.current.paste(), { when: editable });
  useKeybinding("Ctrl+Z", () => commands.current.step(true), { when: editable });
  useKeybinding(["Ctrl+Y", "Ctrl+Shift+Z"], () => commands.current.step(false), { when: editable });

  useEffect(
    () =>
      registerDocumentCommands(path, {
        canUndo: () => !readOnly && history.current.past.length > 0,
        undo: () => commands.current.step(true),
        canRedo: () => !readOnly && history.current.future.length > 0,
        redo: () => commands.current.step(false),
        hasSelection: () => targetRowsRef.current().length > 0,
        cut: () => void (commands.current.copyRows() && commands.current.deleteRows()),
        copy: () => void commands.current.copyRows(),
        canPaste: () => !readOnly,
        paste: () => void commands.current.paste(),
        selectAll: () => setSelected(new Set(rowsRef.current.map((r) => r.id))),
        delete: () => commands.current.deleteRows(),
      }),
    [path, readOnly]
  );
  const targetRowsRef = useRef(targetRows);
  targetRowsRef.current = targetRows;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => notifyDocumentCommands(), [selected]);

  // ── Columns ──────────────────────────────────────────────────────────────

  const columns = useMemo<DataGridColumn<Row>[]>(() => {
    const valueOf = (s: Sibling) => (r: Row) => s.values.get(r.key) ?? "";
    const siblingColumns: DataGridColumn<Row>[] = shownSiblings.map((s) => ({
      key: `${LOCALE_COLUMN}${s.locale}`,
      header: s.entries ? s.locale : `${s.locale} (${t("invalid")})`,
      width: 240,
      sortable: true,
      sortValue: valueOf(s),
      editable: showAll && !!s.entries && !readOnly,
      editValue: valueOf(s),
      render: (r) => (r.isNew ? "" : valueOf(s)(r)),
    }));
    return [
      {
        key: "key",
        header: t("Name"),
        width: 280,
        sortable: true,
        sortValue: (r) => r.key,
        editable: !readOnly,
        hideable: false,
        render: (r) => (r.isNew ? <span className="ylang-placeholder">{t("Type to add a resource…")}</span> : r.key),
      },
      {
        key: "value",
        header: showAll || shownSiblings.length > 0 ? `${t("Value")} (${ownLocale})` : t("Value"),
        width: 300,
        sortable: true,
        sortValue: (r) => r.value,
        editable: !readOnly,
      },
      ...siblingColumns,
      { key: "comment", header: t("Comment"), width: 240, sortable: true, sortValue: (r) => r.comment, editable: !readOnly },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownSiblings, showAll, readOnly, ownLocale, locale]);

  if (!parsed.ok) {
    const tab = tabs.find((x) => x.path === path);
    return (
      <div className="ylang-editor ylang-broken">
        <p>{t("This file isn't valid .ylang — line {line}: {error}", { line: parsed.line, error: parsed.error })}</p>
        {tab && <Button onClick={() => void setView(tab.id, "yog.ylang.source")}>{t("View Code")}</Button>}
      </div>
    );
  }

  return (
    <div className="ylang-editor" ref={rootRef}>
      <div className="ylang-toolbar">
        <IconButton size={26} title={t("Add Resource")} disabled={readOnly} onClick={() => gridRef.current?.editCell(NEW_ROW_ID, "key")}>
          <Icon name="plus" size={15} />
        </IconButton>
        <IconButton size={26} title={t("Remove Resource")} disabled={readOnly || targetRows().length === 0} onClick={deleteRows}>
          <Icon name="trash" size={15} />
        </IconButton>
        <span className="ylang-divider" />
        <Button variant={showAll ? "primary" : "subtle"} onClick={toggleShowAll} title={t("Show every <locale>.ylang of this folder as a column")}>
          {t("All Languages")}
        </Button>
        <Button variant="ghost" disabled={readOnly} onClick={() => void addLanguage()}>
          {t("Add Language…")}
        </Button>
        <span className="ylang-spacer" />
        <SearchField className="ylang-search" value={query} onValueChange={setQuery} placeholder={t("Search resources")} />
      </div>
      <div className="ylang-grid">
        <DataGrid<Row>
          key={columns.map((c) => c.key).join("|")}
          handleRef={gridRef}
          columns={columns}
          rows={rows}
          pinnedRows={newRow}
          getRowId={(r) => r.id}
          selectable
          showSelectColumn={false}
          selectedIds={selected}
          onSelectionChange={setSelected}
          cellNavigation
          filterRow={false}
          showGroupPanel={false}
          persistKey={showAll ? undefined : "yog.ylang.grid"}
          onCellEditCommit={commitCell}
          onGridKeyDown={(_, row, column) => {
            activeRef.current = { row, column };
          }}
          rowClassName={(r) => (r.isNew ? "ylang-newrow" : undefined)}
          cellClassName={(r, column) => {
            if (column === "key") return keyProblem(r) ? "ylang-invalid" : undefined;
            if (r.isNew) return undefined;
            if (column === "value") return r.value === "" ? "ylang-missing" : undefined;
            if (column.startsWith(LOCALE_COLUMN)) {
              const s = shownSiblings.find((x) => `${LOCALE_COLUMN}${x.locale}` === column);
              return s?.entries && !s.values.get(r.key) ? "ylang-missing" : undefined;
            }
            return undefined;
          }}
          cellTitle={(r, column) => {
            if (column === "key") return keyProblem(r);
            if (column.startsWith(LOCALE_COLUMN) && !r.isNew && missingIn(r).includes(column.slice(LOCALE_COLUMN.length)))
              return t("Not translated — the game shows the {locale} text.", { locale: REFERENCE_LOCALE });
            return undefined;
          }}
          emptyState={query ? t("No resources match the search.") : t("No resources yet.")}
        />
      </div>
      <div className="ylang-status">
        <span>{tn(entries.length, "{count} resource", "{count} resources")}</span>
        {errors > 0 && <span className="ylang-status-error">{tn(errors, "{count} error", "{count} errors")}</span>}
        {missing > 0 && <span className="ylang-status-warning">{tn(missing, "{count} missing translation", "{count} missing translations")}</span>}
        {showAll && <span>{tn(siblings.length + 1, "{count} language", "{count} languages")}</span>}
      </div>
    </div>
  );
}
