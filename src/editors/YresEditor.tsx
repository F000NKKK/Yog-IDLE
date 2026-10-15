import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
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
  withShortcut,
} from "substrate-platform-ui";
import { useOpenFiles } from "../OpenFilesContext";
import { reportError } from "../reportError";
import {
  accessorName,
  coerceValue,
  isColor,
  isEntryName,
  isLocaleName,
  NEUTRAL_LOCALE,
  parseYres,
  RESOURCE_TYPES,
  serializeYres,
  splitYresPath,
  textMap,
  valueProblem,
  yresFileName,
  type ResourceType,
  type YresEntry,
} from "../lang/yres";
import "./YresEditor.css";
import { files } from "../files";
import { useFsChanged, useWatchedFolders } from "../fsWatch";

/** Another file of the same resource set — the neutral one or a culture variant: a column of texts. */
interface Sibling {
  /** `null` = the neutral file. */
  locale: string | null;
  path: string;
  /** `null` when it doesn't parse — shown, but not editable here. */
  entries: YresEntry[] | null;
  texts: Map<string, string>;
}

/** One grid row: an entry of this file (or the empty "new row" at the end). */
interface Row {
  id: string;
  /** Index in this file's entries; -1 for the new row. */
  index: number;
  name: string;
  type: ResourceType;
  value: string | number | boolean;
  comment: string;
  isNew?: boolean;
}

const NEW_ROW_ID = "__new__";
const CULTURE_COLUMN = "loc:";
const SHOW_ALL_KEY = "yog.yres.showAllLanguages";
export const YRES_SOURCE_VIEW = "yog.yres.source";

const TYPE_LABELS: Record<ResourceType, string> = {
  string: "Text",
  image: "Image",
  file: "File",
  sound: "Sound",
  color: "Color",
  number: "Number",
  bool: "Boolean",
};

/** Tab-separated rows for the clipboard; tabs, newlines and backslashes escaped. */
function escapeCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r?\n/g, "\\n");
}

function unescapeCell(text: string): string {
  return text.replace(/\\(.)/g, (_, c: string) => (c === "t" ? "\t" : c === "n" ? "\n" : c));
}

const columnOf = (locale: string | null) => `${CULTURE_COLUMN}${locale ?? ""}`;
const localeLabel = (locale: string | null) => locale ?? NEUTRAL_LOCALE;
/** `#RRGGBB` of a `#RRGGBB`/`#AARRGGBB` color — what `<input type="color">` takes. */
const rgbOf = (color: string) => (isColor(color) ? `#${color.slice(-6)}` : "#ffffff");
/** CSS for a `#AARRGGBB`/`#RRGGBB` color. */
function cssColor(color: string): string {
  if (!isColor(color)) return "transparent";
  if (color.length === 7) return color;
  const a = parseInt(color.slice(1, 3), 16) / 255;
  return `#${color.slice(3)}${Math.round(a * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

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
export function YresEditor({ path, content, onChange, readOnly, contentVersion }: EditorProps) {
  const t = useT();
  const locale = useLocale();
  const { tabs, updateContent, setView } = useOpenFiles();
  const parsed = useMemo(() => parseYres(content), [content]);
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
    (next: YresEntry[]) => {
      if (readOnly) return;
      const text = serializeYres(next.map(({ line: _, ...e }) => e));
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
        const result = parseYres(text);
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
      const text = serializeYres(next.map(({ line: _, ...e }) => e));
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
      accessors.set(accessorName(e.name), (accessors.get(accessorName(e.name)) ?? 0) + 1);
    }
    return { counts, accessors };
  }, [entries]);

  const rows = useMemo<Row[]>(() => {
    const all = entries.map((e, index) => ({ id: `r${index}`, index, name: e.name, type: e.type, value: e.value, comment: e.comment ?? "" }));
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (r) =>
        [r.name, String(r.value), r.comment].some((s) => s.toLowerCase().includes(needle)) ||
        shownSiblings.some((s) => s.texts.get(r.name)?.toLowerCase().includes(needle))
    );
  }, [entries, query, shownSiblings]);

  const newRow = useMemo<Row[]>(
    () => (readOnly ? [] : [{ id: NEW_ROW_ID, index: -1, name: "", type: "string", value: "", comment: "", isNew: true }]),
    [readOnly]
  );

  const nameProblem = (row: Pick<Row, "name" | "isNew">): string | undefined => {
    if (row.isNew) return undefined;
    if (row.name.trim() === "") return t("The name can't be empty.");
    if (!isEntryName(row.name)) return t("A name is letters, digits and _, optionally dotted (screen.title), not starting with a digit.");
    if ((nameCounts.counts.get(row.name) ?? 0) > 1) return t("Another resource has the same name.");
    if ((nameCounts.accessors.get(accessorName(row.name)) ?? 0) > 1)
      return t("Another resource has the same accessor name ({name}).", { name: accessorName(row.name) });
    if (isCulture && neutral?.entries && !neutral.entries.some((e) => e.name === row.name))
      return t("The neutral file {file} has no resource of this name.", { file: yresFileName(set, null) });
    return undefined;
  };

  const valueIssue = (row: Row): string | undefined => {
    if (row.isNew) return undefined;
    if (isCulture && row.type !== "string") return t("A language file holds texts only.");
    const problem = valueProblem({ name: row.name, type: row.type, value: row.value });
    return problem ? t("Expected {what}.", { what: t(problem) }) : undefined;
  };

  const untranslated = (row: Row, s: Sibling) => !!s.entries && s.locale !== null && row.type === "string" && !s.texts.get(row.name);

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
      if (!sibling?.entries || !editableSibling(sibling) || row.isNew || row.type !== "string") return;
      if ((sibling.texts.get(row.name) ?? "") === text) return;
      const has = sibling.entries.some((e) => e.name === row.name);
      void writeSibling(
        sibling,
        has
          ? sibling.entries.map((e) => (e.name === row.name ? { ...e, value: text } : e))
          : [...sibling.entries, { name: row.name, type: "string", value: text }]
      );
      return;
    }
    if (row.isNew) {
      if (text === "") return;
      const created: YresEntry = { name: "", type: "string", value: "" };
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
      const value = entry.type === "number" || entry.type === "bool" ? coerceValue(entry.type, text) : text;
      if (value === entry.value) return;
      next = { ...entry, value };
    } else if (column === "type") {
      if (!(RESOURCE_TYPES as readonly string[]).includes(text) || text === entry.type) return;
      const type = text as ResourceType;
      next = { ...entry, type, value: coerceValue(type, entry.value) };
      if (type !== "string") delete next.key;
      if (type !== "image") delete next.texture;
      if (type !== "sound") {
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
      const type = (typed ? cells[2] : "string") as ResourceType;
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
      .filter((e) => e.type === "string" && e.name && !seen.has(e.name) && seen.add(e.name))
      .map((e): YresEntry => ({ name: e.name, type: "string", value: "" }));
    try {
      await files.write(target, serializeYres(texts));
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

  async function pickFile(row: Row): Promise<string | null> {
    const filters =
      row.type === "image"
        ? [{ name: t("PNG Images"), extensions: ["png"] }]
        : row.type === "sound"
          ? [{ name: t("Ogg Vorbis Sounds"), extensions: ["ogg"] }]
          : undefined;
    const picked = await openDialog({ defaultPath: dir, multiple: false, directory: false, filters });
    if (typeof picked !== "string") return null;
    // Relative to this file's folder, `/`-separated — what `yog build` resolves.
    const norm = (p: string) => p.replace(/\\/g, "/");
    const base = norm(dir).replace(/\/+$/, "");
    const file = norm(picked);
    return file.startsWith(`${base}/`) ? file.slice(base.length + 1) : file;
  }

  const filePath = (value: string) => (/^([a-zA-Z]:)?[/\\]/.test(value) ? value : `${dir}${sep}${value.replace(/\//g, sep)}`);
  // An image changed on disk shows anew: its folder is watched, and the
  // version in its URL (the webview caches by URL) bumped.
  const [assetVersion, setAssetVersion] = useState(0);
  const shownFiles = useMemo(
    () => rows.filter((r) => r.type === "image" || r.type === "file").map((r) => filePath(String(r.value))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, dir],
  );
  useWatchedFolders(`yres:${path}`, shownFiles.map((f) => f.slice(0, Math.max(f.lastIndexOf("/"), f.lastIndexOf("\\")))));
  useFsChanged((paths) => {
    if (paths.some((p) => shownFiles.includes(p))) setAssetVersion((v) => v + 1);
  });
  const fileUrl = (value: string) => `${convertFileSrc(filePath(value))}?v=${assetVersion}`;

  // ── Keyboard and Edit menu ──────────────────────────────────────────────

  const gridFocused = () => {
    const el = document.activeElement;
    return !!rootRef.current && !!el && rootRef.current.contains(el) && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement);
  };
  const editable = () => !readOnly && gridFocused();
  const focusedWithin = () => !!rootRef.current && rootRef.current.contains(document.activeElement);
  const commands = useRef({ deleteRows, copyRows, paste, step, targetRows, rows });
  commands.current = { deleteRows, copyRows, paste, step, targetRows, rows };

  useKeybinding("Delete", () => commands.current.deleteRows(), { when: editable });
  useKeybinding("Ctrl+C", () => void commands.current.copyRows(), { when: gridFocused });
  useKeybinding("Ctrl+X", () => void (commands.current.copyRows() && commands.current.deleteRows()), { when: editable });
  useKeybinding("Ctrl+V", () => void commands.current.paste(), { when: editable });
  useKeybinding("Ctrl+Z", () => commands.current.step(true), { when: editable });
  useKeybinding(["Ctrl+Y", "Ctrl+Shift+Z"], () => commands.current.step(false), { when: editable });
  const viewCode = () => {
    const tab = tabsRef.current.find((x) => x.path === path);
    if (tab) void setView(tab.id, YRES_SOURCE_VIEW);
  };
  useKeybinding("F7", viewCode, { when: focusedWithin });

  useEffect(
    () =>
      registerDocumentCommands(path, {
        canUndo: () => !readOnly && history.current.past.length > 0,
        undo: () => commands.current.step(true),
        canRedo: () => !readOnly && history.current.future.length > 0,
        redo: () => commands.current.step(false),
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
      case "color":
        return (
          <span className="yres-value">
            <span className="yres-swatch" style={{ background: cssColor(String(v)) }} />
            <span className="yres-mono">{String(v)}</span>
          </span>
        );
      case "image":
        return (
          <span className="yres-value">
            {typeof v === "string" && v && <img className="yres-thumb" src={fileUrl(v)} alt="" draggable={false} />}
            <span>{String(v)}</span>
          </span>
        );
      case "file":
      case "sound":
        return (
          <span className="yres-value">
            <Icon name="file" size={13} />
            <span>{String(v)}</span>
          </span>
        );
      case "bool":
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
      case "number":
        return <span className="yres-mono">{String(v)}</span>;
      default:
        return String(v);
    }
  }

  function renderValueEdit(row: Row, commit: (value: string, move?: "down" | "next" | "prev") => void, cancel: () => void, initial?: string) {
    const value = String(row.value);
    switch (row.isNew ? "string" : row.type) {
      case "bool":
        return <ImmediateCommit run={() => commit(String(row.value !== true))} />;
      case "color":
        return <ColorEdit value={value} initial={initial} commit={commit} cancel={cancel} />;
      case "image":
      case "file":
      case "sound":
        return <CellInput value={value} initial={initial} commit={commit} cancel={cancel} browse={() => pickFile(row)} browseTitle={t("Browse…")} />;
      default:
        return <CellInput value={value} initial={initial} commit={commit} cancel={cancel} />;
    }
  }

  // ── Columns ──────────────────────────────────────────────────────────────

  const columns = useMemo<DataGridColumn<Row>[]>(() => {
    const textOf = (s: Sibling) => (r: Row) => (r.type === "string" ? (s.texts.get(r.name) ?? "") : "");
    const cultureColumns: DataGridColumn<Row>[] = shownSiblings.map((s) => ({
      key: columnOf(s.locale),
      header: `${s.locale === null ? t("Neutral") : s.locale}${s.entries ? "" : ` (${t("invalid")})`}`,
      width: 220,
      sortable: true,
      sortValue: textOf(s),
      editable: editableSibling(s),
      editValue: textOf(s),
      renderEdit: (r, commit, cancel, initial) =>
        r.isNew || r.type !== "string" ? <ImmediateCommit run={cancel} /> : <CellInput value={textOf(s)(r)} initial={initial} commit={commit} cancel={cancel} />,
      render: (r) => (r.isNew ? "" : r.type === "string" ? textOf(s)(r) : <span className="yres-na">—</span>),
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
      <div className="yres-toolbar">
        <IconButton title={t("Add Resource")} disabled={readOnly} onClick={() => gridRef.current?.editCell(NEW_ROW_ID, "name")}>
          <Icon name="plus" />
        </IconButton>
        <IconButton title={t("Remove Resource")} disabled={readOnly || targetRows().length === 0} onClick={deleteRows}>
          <Icon name="trash" />
        </IconButton>
        <span className="yres-divider" />
        <Button variant={showAll ? "primary" : "subtle"} onClick={toggleShowAll} title={t("Show every language of this resource set as a column")}>
          {t("All Languages")}
        </Button>
        <Button variant="ghost" disabled={readOnly} onClick={() => void addLanguage()}>
          {t("Add Language…")}
        </Button>
        <span className="yres-spacer" />
        <SearchField className="yres-search" value={query} onValueChange={setQuery} placeholder={t("Search resources")} />
        <IconButton title={withShortcut("View Code", "f7")} onClick={viewCode}>
          <Icon name="code" />
        </IconButton>
      </div>
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
            if (column === "value") return valueIssue(r) ? "yres-invalid" : r.type === "string" && r.value === "" ? "yres-missing" : undefined;
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

// ── Cell editors ─────────────────────────────────────────────────────────────

type Commit = (value: string, move?: "down" | "next" | "prev") => void;

/** Ends an edit as soon as it starts — a cell that toggles (a flag) or can't be edited. */
function ImmediateCommit({ run }: { run: () => void }) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    run();
  });
  return null;
}

/** Enter/Tab/Esc as the grid's own editor handles them. */
function editKeys(e: KeyboardEvent<HTMLElement>, value: () => string, commit: Commit, cancel: () => void) {
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
function CellInput({
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
function ColorEdit({ value, initial, commit, cancel }: { value: string; initial?: string; commit: Commit; cancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const picking = useRef(false);
  const [text, setText] = useState(initial ?? value);
  return (
    <span className="yres-cell-edit" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <span className="yres-swatch" style={{ background: cssColor(text) }} />
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
        value={rgbOf(text).toLowerCase()}
        onMouseDown={() => {
          picking.current = true;
        }}
        onChange={(e) => {
          const alpha = isColor(text) && text.length === 9 ? text.slice(1, 3) : "";
          setText(`#${alpha}${e.target.value.slice(1)}`.toUpperCase());
        }}
        onBlur={() => {
          picking.current = false;
          ref.current?.focus();
        }}
      />
    </span>
  );
}

function TypeSelect({ value, commit, cancel }: { value: ResourceType; commit: Commit; cancel: () => void }) {
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
