import { resKind } from "../data/yogIds.generated";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Button,
  DataGrid,
  type DataGridColumn,
  type DataGridHandle,
  type DirEntry,
  type EditorProps,
  notifyDocumentCommands,
  promptDialog,
  registerDocumentCommands,
  reportError,
  SearchField,
  Spacer,
  tn,
  Toolbar,
  ToolbarButton,
  ToolbarGroup,
  useKeybinding,
  useLocale,
  useT,
} from "substrate-platform-ui";
import { useOpenFiles } from "../OpenFilesContext";
import {
  coerceValue,
  isLocaleName,
  NEUTRAL_LOCALE,
  parseYres,
  RESOURCE_TYPES,
  type YresParse,
  serializeYres,
  splitYresPath,
  textMap,
  yresFileName,
  type ResourceType,
  type YresEntry,
} from "../lang/yres";
import "./YresEditor.css";
import { cli } from "../cli";
import { MediaValue, IMAGE_EXTENSIONS } from "./MediaValue";
import { files } from "../files";
import { columnOf, cssColor, CULTURE_COLUMN, escapeCell, localeLabel, NEW_ROW_ID, type Row, SHOW_ALL_KEY, type Sibling, TYPE_LABELS, unescapeCell } from "./yres/yresModel";
import { CellInput, ColorEdit, ImmediateCommit, TypeSelect } from "./yres/cellEditors";

export const YRES_SOURCE_VIEW = "yog.yres.source";

/**
 * The `.yres` designer, like Visual Studio's ResX editor: Name | Value | Type
 * | Comment in a grid, edited in place with an editor per type (text, color,
 * image/file/sound path, number, flag), and — with "All Languages" — every
 * culture variant `<Set>.<locale>.yres` of the folder as another column of
 * texts, untranslated ones marked (VS 2022's multi-language resource view).
 * Edits of this file go through `onChange` (dirty state, Save, undo/redo);
 * edits of another language's column go to that file — its open tab if it
 * has one, straight to disk otherwise. Every edit rewrites the file
 * formatted: 2-space indent, entry order and comments kept.
 */
export function YresEditor({ path, content, onChange, readOnly }: EditorProps) {
  const t = useT();
  const locale = useLocale();
  const { tabs, updateContent, setView } = useOpenFiles();
  // Parsed by the CLI service; the last parse shown until the next arrives.
  const [parsed, setParsed] = useState<YresParse>({ ok: true, entries: [] });
  useEffect(() => {
    let live = true;
    void parseYres(content).then((p) => live && setParsed(p));
    return () => {
      live = false;
    };
  }, [content]);
  const entries = useMemo(() => (parsed.ok ? parsed.entries : []), [parsed]);
  const { dir, set, locale: ownLocale, sep } = splitYresPath(path);
  const isCulture = ownLocale !== null;

  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(() => localStorage.getItem(SHOW_ALL_KEY) === "1");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [siblings, setSiblings] = useState<Sibling[]>([]);
  const gridRef = useRef<DataGridHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** The row/column the grid's keyboard focus was last on — where a single-value paste goes. */
  const activeRef = useRef<{ row: Row | null; column: string | null }>({ row: null, column: null });

  // ── Edits (Undo/Redo: the platform's history of the text) ──────────────

  const contentRef = useRef(content);
  contentRef.current = content;

  const apply = useCallback(
    async (next: YresEntry[]) => {
      if (readOnly) return;
      const text = await serializeYres(next.map(({ line: _, ...e }) => e));
      if (text === contentRef.current) return;
      onChange(text);
    },
    [onChange, readOnly]
  );

  // ── The other files of the set ────────────────────────────────────────────

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const loadSiblings = useCallback(async () => {
    let list: DirEntry[];
    try {
      list = await files.list(dir);
    } catch {
      return;
    }
    const setFiles = list.filter((e) => {
      if (e.kind !== "file" || !/\.yres$/i.test(e.name) || e.path === path) return false;
      return splitYresPath(e.path).set === set;
    });
    const loaded = await Promise.all(
      setFiles.map(async (file): Promise<Sibling | null> => {
        const open = tabsRef.current.find((tab) => tab.path === file.path && tab.textLoaded);
        let text: string;
        try {
          text = open ? open.content : await files.read(file.path);
        } catch {
          return null;
        }
        const result = await parseYres(text);
        const entries = result.ok ? result.entries : null;
        return { locale: splitYresPath(file.path).locale, path: file.path, entries, texts: textMap(entries ?? []) };
      })
    );
    setSiblings(
      loaded
        .filter((s): s is Sibling => !!s)
        // The neutral file first, the cultures by name.
        .sort((a, b) => (a.locale === null ? -1 : b.locale === null ? 1 : a.locale.localeCompare(b.locale)))
    );
  }, [dir, path, set]);

  useEffect(() => {
    void loadSiblings();
    const onFocus = () => void loadSiblings();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadSiblings, showAll]);

  /** Writes another file of the set: into its open tab (left unsaved, like any edit) or straight to disk. */
  const writeSibling = useCallback(
    async (sibling: Sibling, next: YresEntry[]) => {
      const text = await serializeYres(next.map(({ line: _, ...e }) => e));
      const open = tabsRef.current.find((tab) => tab.path === sibling.path && tab.textLoaded);
      if (open) updateContent(open.id, text);
      else {
        try {
          await files.write(sibling.path, text);
        } catch (err) {
          reportError(t("Failed to save {path}: {error}", { path: sibling.path, error: String(err) }));
          return;
        }
      }
      setSiblings((prev) => prev.map((s) => (s.path === sibling.path ? { ...s, entries: next, texts: textMap(next) } : s)));
    },
    [t, updateContent]
  );

  const neutral = siblings.find((s) => s.locale === null);
  // A culture file always shows the neutral texts next to its own, read-only.
  const shownSiblings = showAll ? siblings : isCulture && neutral ? [neutral] : [];
  /** A column's file can be edited from here: a culture variant (texts only), in All Languages. */
  const editableSibling = (s: Sibling) => showAll && !readOnly && !!s.entries && s.locale !== null;

  // ── Rows and validation ─────────────────────────────────────────────────

  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const accessors = new Map<string, number>();
    for (const e of entries) {
      counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
      if (e.accessor) accessors.set(e.accessor, (accessors.get(e.accessor) ?? 0) + 1);
    }
    return { counts, accessors };
  }, [entries]);

  const rows = useMemo<Row[]>(() => {
    const all = entries.map((e, index) => ({ id: `r${index}`, index, name: e.name, type: e.type, value: e.value, comment: e.comment ?? "", accessor: e.accessor, problem: e.nameProblem, valueProblem: e.valueProblem, argb: e.argb }));
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (r) =>
        [r.name, String(r.value), r.comment].some((s) => s.toLowerCase().includes(needle)) ||
        shownSiblings.some((s) => s.texts.get(r.name)?.toLowerCase().includes(needle))
    );
  }, [entries, query, shownSiblings]);

  const newRow = useMemo<Row[]>(
    () => (readOnly ? [] : [{ id: NEW_ROW_ID, index: -1, name: "", type: resKind.STRING, value: "", comment: "", isNew: true }]),
    [readOnly]
  );

  const nameProblem = (row: Pick<Row, "name" | "isNew" | "accessor" | "problem">): string | undefined => {
    if (row.isNew) return undefined;
    if (row.name.trim() === "") return t("The name can't be empty.");
    // What the CLI found wrong with the name (the build's own rule).
    if (row.problem) return row.problem;
    if ((nameCounts.counts.get(row.name) ?? 0) > 1) return t("Another resource has the same name.");
    if (row.accessor && (nameCounts.accessors.get(row.accessor) ?? 0) > 1)
      return t("Another resource has the same accessor name ({name}).", { name: row.accessor });
    if (isCulture && neutral?.entries && !neutral.entries.some((e) => e.name === row.name))
      return t("The neutral file {file} has no resource of this name.", { file: yresFileName(set, null) });
    return undefined;
  };

  const valueIssue = (row: Row): string | undefined => {
    if (row.isNew) return undefined;
    if (isCulture && row.type !== resKind.STRING) return t("A language file holds texts only.");
    // The CLI's check — the build's own.
    return row.valueProblem;
  };

  const untranslated = (row: Row, s: Sibling) => !!s.entries && s.locale !== null && row.type === resKind.STRING && !s.texts.get(row.name);

  const errors = rows.reduce((n, r) => n + (nameProblem(r) || valueIssue(r) ? 1 : 0), 0);
  const missing = showAll
    ? entries.reduce((n, e, index) => n + siblings.filter((s) => untranslated({ id: "", index, name: e.name, type: e.type, value: e.value, comment: "" }, s)).length, 0)
    : 0;

  // ── Edits ────────────────────────────────────────────────────────────────

  function renameInSiblings(from: string, to: string) {
    for (const s of siblings) {
      if (!s.entries || s.locale === null || !s.entries.some((e) => e.name === from) || s.entries.some((e) => e.name === to)) continue;
      void writeSibling(
        s,
        s.entries.map((e) => (e.name === from ? { ...e, name: to } : e))
      );
    }
  }

  function commitCell(row: Row, column: string, text: string) {
    if (readOnly) return;
    if (column.startsWith(CULTURE_COLUMN)) {
      const sibling = siblings.find((s) => columnOf(s.locale) === column);
      if (!sibling?.entries || !editableSibling(sibling) || row.isNew || row.type !== resKind.STRING) return;
      if ((sibling.texts.get(row.name) ?? "") === text) return;
      const has = sibling.entries.some((e) => e.name === row.name);
      void writeSibling(
        sibling,
        has
          ? sibling.entries.map((e) => (e.name === row.name ? { ...e, value: text } : e))
          : [...sibling.entries, { name: row.name, type: resKind.STRING, value: text }]
      );
      return;
    }
    if (row.isNew) {
      if (text === "") return;
      const created: YresEntry = { name: "", type: resKind.STRING, value: "" };
      if (column === "name") created.name = text.trim();
      else if (column === "value") created.value = text;
      else if (column === "comment") created.comment = text;
      else if (column === "type" && (RESOURCE_TYPES as readonly string[]).includes(text)) {
        created.type = text as ResourceType;
        created.value = coerceValue(created.type, "");
      } else return;
      apply([...entries, created]);
      return;
    }
    const entry = entries[row.index];
    if (!entry) return;
    let next: YresEntry;
    if (column === "name") {
      const name = text.trim();
      if (name === entry.name) return;
      next = { ...entry, name };
      if (showAll && !isCulture && name !== "" && !nameCounts.counts.has(name)) renameInSiblings(entry.name, name);
    } else if (column === "value") {
      const value = entry.type === resKind.NUMBER || entry.type === resKind.BOOL ? coerceValue(entry.type, text) : text;
      if (value === entry.value) return;
      next = { ...entry, value };
    } else if (column === "type") {
      if (!(RESOURCE_TYPES as readonly string[]).includes(text) || text === entry.type) return;
      const type = text as ResourceType;
      next = { ...entry, type, value: coerceValue(type, entry.value) };
      if (type !== resKind.STRING) delete next.key;
      if (type !== resKind.SOUND) {
        delete next.event;
        delete next.subtitle;
      }
    } else if (column === "comment") {
      if (text === (entry.comment ?? "")) return;
      next = { ...entry, comment: text };
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
    if (showAll && !isCulture) {
      // As in VS's multi-language view: a resource removed goes from every language.
      const gone = new Set(doomed.map((r) => r.name).filter((name) => !remaining.some((e) => e.name === name)));
      for (const s of siblings) {
        if (s.locale !== null && s.entries?.some((e) => gone.has(e.name)))
          void writeSibling(
            s,
            s.entries.filter((e) => !gone.has(e.name))
          );
      }
    }
    setSelected(new Set());
  }

  function copyRows(): boolean {
    const picked = targetRows();
    if (picked.length === 0) return false;
    const text = picked.map((r) => [r.name, String(r.value), r.type, r.comment].map(escapeCell).join("\t")).join("\n");
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
    // Rows: Name, Value[, Type][, Comment] — as copied here, or two/three columns from a spreadsheet.
    const next = [...entries];
    for (const line of lines) {
      const cells = line.split("\t").map(unescapeCell);
      const name = (cells[0] ?? "").trim();
      if (!name) continue;
      const typed = (RESOURCE_TYPES as readonly string[]).includes(cells[2] ?? "");
      const type = (typed ? cells[2] : resKind.STRING) as ResourceType;
      const comment = typed ? cells[3] : cells[2];
      const at = next.findIndex((e) => e.name === name);
      const entry: YresEntry = { ...(at >= 0 ? next[at] : {}), name, type, value: coerceValue(type, cells[1] ?? "") };
      if (comment) entry.comment = comment;
      if (at >= 0) next[at] = entry;
      else next.push(entry);
    }
    apply(next);
  }

  async function addLanguage() {
    const taken = new Set<string>([NEUTRAL_LOCALE, ...siblings.map((s) => s.locale ?? NEUTRAL_LOCALE)]);
    if (ownLocale) taken.add(ownLocale);
    const name = await promptDialog({
      title: t("Add Language"),
      message: t("A new {file} next to this one, with every text of the set left to translate.", { file: yresFileName(set, "<locale>") }),
      label: t("Locale"),
      placeholder: "ru_ru",
      confirmLabel: t("Add"),
      validate: (value) => {
        const v = value.trim().toLowerCase();
        if (!v) return "";
        if (!isLocaleName(v)) return t("A Minecraft locale code, like ru_ru, de_de or pt_br.");
        if (v === NEUTRAL_LOCALE) return t("The neutral file {file} already holds the {locale} texts.", { file: yresFileName(set, null), locale: NEUTRAL_LOCALE });
        if (taken.has(v)) return t("This folder already has {name}.", { name: yresFileName(set, v) });
        return null;
      },
    });
    if (!name) return;
    const target = `${dir}${sep}${yresFileName(set, name.trim().toLowerCase())}`;
    const source = isCulture ? (neutral?.entries ?? []) : entries;
    const seen = new Set<string>();
    const texts = source
      .filter((e) => e.type === resKind.STRING && e.name && !seen.has(e.name) && seen.add(e.name))
      .map((e): YresEntry => ({ name: e.name, type: resKind.STRING, value: "" }));
    try {
      await files.write(target, await serializeYres(texts));
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

  /** A file picked from disk, taken into the entry by the CLI (`media.import`): its `@bytes:` value. */
  async function pickFile(row: Row): Promise<string | null> {
    const filters =
      row.type === resKind.IMAGE
        ? [{ name: t("Images"), extensions: IMAGE_EXTENSIONS }]
        : row.type === resKind.SOUND
          ? [{ name: t("Ogg Vorbis Sounds"), extensions: ["ogg"] }]
          : undefined;
    const picked = await openDialog({ defaultPath: dir, multiple: false, directory: false, filters });
    if (typeof picked !== "string") return null;
    try {
      return (await cli<{ value: string }>("media.import", { file: picked })).value;
    } catch (err) {
      reportError(String(err));
      return null;
    }
  }

  // ── Keyboard and Edit menu ──────────────────────────────────────────────

  const gridFocused = () => {
    const el = document.activeElement;
    return !!rootRef.current && !!el && rootRef.current.contains(el) && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement);
  };
  const editable = () => !readOnly && gridFocused();
  const focusedWithin = () => !!rootRef.current && rootRef.current.contains(document.activeElement);
  const commands = useRef({ deleteRows, copyRows, paste, targetRows, rows });
  commands.current = { deleteRows, copyRows, paste, targetRows, rows };

  useKeybinding("Delete", () => commands.current.deleteRows(), { when: editable });
  useKeybinding("Ctrl+C", () => void commands.current.copyRows(), { when: gridFocused });
  useKeybinding("Ctrl+X", () => void (commands.current.copyRows() && commands.current.deleteRows()), { when: editable });
  useKeybinding("Ctrl+V", () => void commands.current.paste(), { when: editable });
  const viewCode = () => {
    const tab = tabsRef.current.find((x) => x.path === path);
    if (tab) void setView(tab.id, YRES_SOURCE_VIEW);
  };
  useKeybinding("F7", viewCode, { when: focusedWithin });

  useEffect(
    () =>
      registerDocumentCommands(path, {
        hasSelection: () => commands.current.targetRows().length > 0,
        cut: () => void (commands.current.copyRows() && commands.current.deleteRows()),
        copy: () => void commands.current.copyRows(),
        canPaste: () => !readOnly,
        paste: () => void commands.current.paste(),
        selectAll: () => setSelected(new Set(commands.current.rows.map((r) => r.id))),
        delete: () => commands.current.deleteRows(),
      }),
    [path, readOnly]
  );
  useEffect(() => notifyDocumentCommands(), [selected]);

  // ── Cells ────────────────────────────────────────────────────────────────

  function renderValue(row: Row) {
    if (row.isNew) return null;
    const v = row.value;
    switch (row.type) {
      case resKind.COLOR:
        return (
          <span className="yres-value">
            <span className="yres-swatch" style={{ background: cssColor(row.argb) }} />
            <span className="yres-mono">{String(v)}</span>
          </span>
        );
      case resKind.IMAGE:
      case resKind.SOUND:
      case resKind.FILE:
        return <MediaValue type={row.type} value={String(v)} />;
      case resKind.BOOL:
        return (
          <input
            type="checkbox"
            className="yres-check"
            checked={v === true}
            disabled={readOnly}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onChange={(e) => commitCell(row, "value", String(e.target.checked))}
          />
        );
      case resKind.NUMBER:
        return <span className="yres-mono">{String(v)}</span>;
      default:
        return String(v);
    }
  }

  function renderValueEdit(row: Row, commit: (value: string, move?: "down" | "next" | "prev") => void, cancel: () => void, initial?: string) {
    const value = String(row.value);
    switch (row.isNew ? resKind.STRING : row.type) {
      case resKind.BOOL:
        return <ImmediateCommit run={() => commit(String(row.value !== true))} />;
      case resKind.COLOR:
        return <ColorEdit value={value} argb={row.argb} initial={initial} commit={commit} cancel={cancel} />;
      case resKind.IMAGE:
      case resKind.FILE:
      case resKind.SOUND:
        return <CellInput value={value} initial={initial} commit={commit} cancel={cancel} browse={() => pickFile(row)} browseTitle={t("Browse…")} />;
      default:
        return <CellInput value={value} initial={initial} commit={commit} cancel={cancel} />;
    }
  }

  // ── Columns ──────────────────────────────────────────────────────────────

  const columns = useMemo<DataGridColumn<Row>[]>(() => {
    const textOf = (s: Sibling) => (r: Row) => (r.type === resKind.STRING ? (s.texts.get(r.name) ?? "") : "");
    const cultureColumns: DataGridColumn<Row>[] = shownSiblings.map((s) => ({
      key: columnOf(s.locale),
      header: `${s.locale === null ? t("Neutral") : s.locale}${s.entries ? "" : ` (${t("invalid")})`}`,
      width: 220,
      sortable: true,
      sortValue: textOf(s),
      editable: editableSibling(s),
      editValue: textOf(s),
      renderEdit: (r, commit, cancel, initial) =>
        r.isNew || r.type !== resKind.STRING ? <ImmediateCommit run={cancel} /> : <CellInput value={textOf(s)(r)} initial={initial} commit={commit} cancel={cancel} />,
      render: (r) => (r.isNew ? "" : r.type === resKind.STRING ? textOf(s)(r) : <span className="yres-na">—</span>),
    }));
    return [
      {
        key: "name",
        header: t("Name"),
        width: 240,
        sortable: true,
        sortValue: (r) => r.name,
        editable: !readOnly,
        hideable: false,
        render: (r) => (r.isNew ? <span className="yres-placeholder">{t("Type to add a resource…")}</span> : r.name),
      },
      {
        key: "value",
        header: showAll || shownSiblings.length > 0 ? `${t("Value")} (${localeLabel(ownLocale)})` : t("Value"),
        width: 300,
        sortable: true,
        sortValue: (r) => String(r.value),
        editable: !readOnly,
        editValue: (r) => String(r.value),
        render: renderValue,
        renderEdit: renderValueEdit,
      },
      ...(isCulture
        ? []
        : [
            {
              key: "type",
              header: t("Type"),
              width: 100,
              sortable: true,
              sortValue: (r: Row) => r.type,
              editable: !readOnly,
              render: (r: Row) => (r.isNew ? "" : t(TYPE_LABELS[r.type])),
              renderEdit: (r: Row, commit: (value: string) => void, cancel: () => void) => <TypeSelect value={r.type} commit={commit} cancel={cancel} />,
            } satisfies DataGridColumn<Row>,
          ]),
      ...cultureColumns,
      { key: "comment", header: t("Comment"), width: 240, sortable: true, sortValue: (r) => r.comment, editable: !readOnly },
    ];
    // Cell renderers read the latest state through closures over this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownSiblings, showAll, readOnly, ownLocale, isCulture, locale, entries, siblings, dir]);

  if (!parsed.ok) {
    return (
      <div className="yres-editor yres-broken">
        <p>{t("This file isn't valid .yres — line {line}: {error}", { line: parsed.line, error: parsed.error })}</p>
        <Button onClick={viewCode}>{t("View Code")}</Button>
      </div>
    );
  }

  return (
    <div className="yres-editor" ref={rootRef}>
      <Toolbar>
        <ToolbarGroup>
          <ToolbarButton icon="plus" label="Add Resource" disabled={readOnly} onClick={() => gridRef.current?.editCell(NEW_ROW_ID, "name")} />
          <ToolbarButton icon="trash" label="Remove Resource" disabled={readOnly || targetRows().length === 0} onClick={deleteRows} />
        </ToolbarGroup>
        <ToolbarGroup>
          <ToolbarButton label="All Languages" tooltip="Show every language of this resource set as a column" active={showAll} onClick={toggleShowAll} />
          <ToolbarButton icon="plus" label="Language…" showLabel disabled={readOnly} onClick={() => void addLanguage()} />
        </ToolbarGroup>
        <Spacer />
        <SearchField className="yres-search" value={query} onValueChange={setQuery} placeholder={t("Search resources")} />
        <ToolbarButton icon="code" label="View Code" shortcut="f7" onClick={viewCode} />
      </Toolbar>
      <div className="yres-grid">
        <DataGrid<Row>
          className="sp-datagrid--flush"
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
          persistKey={showAll || isCulture ? undefined : "yog.yres.grid"}
          onCellEditCommit={commitCell}
          onGridKeyDown={(_, row, column) => {
            activeRef.current = { row, column };
          }}
          rowClassName={(r) => (r.isNew ? "yres-newrow" : undefined)}
          cellClassName={(r, column) => {
            if (column === "name") return nameProblem(r) ? "yres-invalid" : undefined;
            if (r.isNew) return undefined;
            if (column === "value") return valueIssue(r) ? "yres-invalid" : r.type === resKind.STRING && r.value === "" ? "yres-missing" : undefined;
            if (column.startsWith(CULTURE_COLUMN)) {
              const s = shownSiblings.find((x) => columnOf(x.locale) === column);
              return s && untranslated(r, s) ? "yres-missing" : undefined;
            }
            return undefined;
          }}
          cellTitle={(r, column) => {
            if (column === "name") return nameProblem(r);
            if (column === "value") return valueIssue(r);
            const s = column.startsWith(CULTURE_COLUMN) ? shownSiblings.find((x) => columnOf(x.locale) === column) : undefined;
            if (s && !r.isNew && untranslated(r, s)) return t("Not translated — the game shows the {locale} text.", { locale: NEUTRAL_LOCALE });
            return undefined;
          }}
          emptyState={query ? t("No resources match the search.") : t("No resources yet.")}
        />
      </div>
      <div className="yres-status">
        <span>{tn(entries.length, "{count} resource", "{count} resources")}</span>
        {errors > 0 && <span className="yres-status-error">{tn(errors, "{count} error", "{count} errors")}</span>}
        {missing > 0 && <span className="yres-status-warning">{tn(missing, "{count} missing translation", "{count} missing translations")}</span>}
        {showAll && <span>{tn(siblings.length + 1, "{count} language", "{count} languages")}</span>}
      </div>
    </div>
  );
}

