import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSelect, pt, usePropertyContext, useT, type EditorProps, type PropertyDescriptor, type PropertySet, type PropertyValue, Spacer } from "substrate-platform-ui";
import { ItemHeader } from "../designer/ItemIcons";
import { iconSource, imagePreview, imageSourcesVersion, subscribeImageSources } from "../designer/imageSources";
import { designText, useDesignResources } from "../lang/designResources";
import {
  BOOK_FIELDS,
  CATEGORY_FIELDS,
  ENTRY_FIELDS,
  PAGE_TYPES,
  categoryRef,
  entriesOf,
  freshId,
  moved,
  newPage,
  pageFields,
  refId,
  parseBook,
  serializeBook,
  withField,
  type Book,
  type Field,
  type Json,
  type Obj,
  type Page,
} from "./bookModel";
import "./BookEditor.css";
import { modRootOf } from "../paths";

/** The code view of a `.ybook` (registered in `editors/index.tsx`). */
export const BOOK_SOURCE_VIEW = "yog.book.source";

/** The GUI screen the book is drawn on (the book is 272×180 at full size). */
const SCREEN_W = 300;
const SCREEN_H = 200;
const SCALE = 3;

type Selection =
  | { kind: "book" }
  | { kind: "category"; index: number }
  | { kind: "entry"; index: number }
  | { kind: "page"; entry: number; page: number };

type Action = { kind: "click"; x: number; y: number } | { kind: "show"; entry: string; page: number } | { kind: "home" };

interface Rendered {
  image: string | null;
  scale: number;
  shown: [string, number] | null;
  action: string | null;
  animated: boolean;
  /** The languages the mod's texts are in (besides the neutral one). */
  locales: string[];
  error: string | null;
}

/**
 * `.ybook` guide books, live: the book drawn by yog-book itself — the code
 * the game runs — and read like in the game (click entries, turn pages);
 * the book's outline beside it, and what's selected in either is
 * selected in both. Edits show at once.
 */
export function BookEditor({ path, content, onChange, readOnly }: EditorProps) {
  const t = useT();
  useSyncExternalStore(subscribeImageSources, imageSourcesVersion);
  // `@Book.title` texts shown from the mod's .yres files, as the book shows them.
  useDesignResources(modRootOf(path));
  const parsed = useMemo(() => parseBook(content), [content]);
  const [sel, setSel] = useState<Selection>({ kind: "book" });
  const [rendered, setRendered] = useState<Rendered | null>(null);
  /** The language the book is read in ("": its neutral texts). */
  const [locale, setLocale] = useState("");
  const seq = useRef(0);

  const update = useCallback(
    (change: (b: Book) => Book) => {
      if (readOnly || !parsed) return;
      const text = serializeBook(change(parsed));
      if (text !== content) onChange(text);
    },
    [parsed, content, onChange, readOnly]
  );

  // ── The preview ───────────────────────────────────────────────────────────

  const draw = useCallback(
    (action: Action | null) => {
      const n = ++seq.current;
      invoke<Rendered>("book_designer_render", {
        args: { path, text: content, screenW: SCREEN_W, screenH: SCREEN_H, scale: SCALE, action, locale },
      })
        .then((r) => {
          if (n !== seq.current) return;
          setRendered(r);
          // The reader moved: select where they are.
          if (action?.kind === "click" && parsed) {
            if (r.shown) {
              const entry = parsed.entries.findIndex((e) => e.id === r.shown![0]);
              if (entry >= 0) setSel({ kind: "page", entry, page: r.shown[1] });
            } else if (r.action?.startsWith("cat:")) {
              setSel({ kind: "category", index: Number(r.action.slice(4)) });
            } else if (r.action === "home") {
              setSel({ kind: "book" });
            }
          }
        })
        .catch((e) => n === seq.current && setRendered({ image: null, scale: SCALE, shown: null, action: null, animated: false, locales: [], error: String(e) }));
    },
    [path, content, parsed, locale]
  );

  // Redraw on every edit (a moment after the last keystroke).
  useEffect(() => {
    const id = setTimeout(() => draw(null), 120);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, locale]);
  useEffect(() => () => void invoke("book_designer_close", { path }).catch(() => {}), [path]);

  // A page that moves (an entity, a structure, an ingredient's
  // alternatives) is drawn again and again, as the game does.
  const animated = rendered?.animated ?? false;
  useEffect(() => {
    if (!animated) return;
    let busy = false;
    const id = setInterval(() => {
      if (busy) return;
      busy = true;
      const n = ++seq.current;
      invoke<Rendered>("book_designer_render", {
        args: { path, text: content, screenW: SCREEN_W, screenH: SCREEN_H, scale: SCALE, action: null, locale },
      })
        .then((r) => n === seq.current && setRendered(r))
        .catch(() => {})
        .finally(() => (busy = false));
    }, 120);
    return () => clearInterval(id);
  }, [animated, path, content, locale]);

  /** Selecting in the outline turns the book there. */
  const select = (s: Selection) => {
    setSel(s);
    if (!parsed) return;
    if (s.kind === "page") draw({ kind: "show", entry: parsed.entries[s.entry].id, page: s.page });
    else if (s.kind === "entry") draw({ kind: "show", entry: parsed.entries[s.index].id, page: 0 });
    else if (s.kind === "book") draw({ kind: "home" });
  };

  const onPreviewClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const x = (e.nativeEvent.offsetX / img.clientWidth) * SCREEN_W;
    const y = (e.nativeEvent.offsetY / img.clientHeight) * SCREEN_H;
    draw({ kind: "click", x, y });
  };

  // What Properties shows while the book is active: the selected book, category, entry or page (set below).
  const shownProperties = useRef<PropertySet | null>(null);
  shownProperties.current = null;
  usePropertyContext(path, () => shownProperties.current);

  if (!parsed) {
    return <div className="book-editor book-error">{t("This isn't a book (a JSON object) — fix it in the Code view.")}</div>;
  }
  const book = parsed;

  // ── Outline edits ─────────────────────────────────────────────────────────

  const addCategory = () => {
    const id = freshId(`${ns(book.id)}:category`, book.categories.map((c) => c.id));
    update((b) => ({ ...b, categories: [...b.categories, { id, name: t("New category") }] }));
    setSel({ kind: "category", index: book.categories.length });
  };
  const categoryOfSelection = (): string | undefined => {
    if (sel.kind === "category") return book.categories[sel.index]?.id;
    if (sel.kind === "entry") return refId(book.entries[sel.index]?.category ?? "");
    if (sel.kind === "page") return refId(book.entries[sel.entry]?.category ?? "");
    return book.categories[0]?.id;
  };
  const addEntry = () => {
    const category = categoryOfSelection();
    if (!category) return;
    const id = freshId(`${ns(book.id)}:entry`, book.entries.map((e) => e.id));
    update((b) => ({ ...b, entries: [...b.entries, { id, name: t("New entry"), category: categoryRef(category), pages: [newPage("text")] }] }));
    select({ kind: "entry", index: book.entries.length });
  };
  const entryOfSelection = (): number | undefined => (sel.kind === "entry" ? sel.index : sel.kind === "page" ? sel.entry : undefined);
  const addPage = (type: string) => {
    const entry = entryOfSelection();
    if (entry === undefined) return;
    const at = sel.kind === "page" ? sel.page + 1 : book.entries[entry].pages.length;
    update((b) => {
      const entries = [...b.entries];
      const pages = [...entries[entry].pages];
      pages.splice(at, 0, newPage(type));
      entries[entry] = { ...entries[entry], pages };
      return { ...b, entries };
    });
    setSel({ kind: "page", entry, page: at });
  };
  const remove = () => {
    if (sel.kind === "category") {
      const id = book.categories[sel.index].id;
      update((b) => ({ ...b, categories: b.categories.filter((_, i) => i !== sel.index), entries: b.entries.filter((e) => refId(e.category) !== id) }));
      setSel({ kind: "book" });
    } else if (sel.kind === "entry") {
      update((b) => ({ ...b, entries: b.entries.filter((_, i) => i !== sel.index) }));
      setSel({ kind: "book" });
    } else if (sel.kind === "page") {
      update((b) => {
        const entries = [...b.entries];
        entries[sel.entry] = { ...entries[sel.entry], pages: entries[sel.entry].pages.filter((_, i) => i !== sel.page) };
        return { ...b, entries };
      });
      setSel({ kind: "entry", index: sel.entry });
    }
  };
  const move = (by: number) => {
    if (sel.kind === "category") {
      update((b) => ({ ...b, categories: moved(b.categories, sel.index, by) }));
      setSel({ kind: "category", index: clamp(sel.index + by, book.categories.length) });
    } else if (sel.kind === "page") {
      update((b) => {
        const entries = [...b.entries];
        entries[sel.entry] = { ...entries[sel.entry], pages: moved(entries[sel.entry].pages, sel.page, by) };
        return { ...b, entries };
      });
      setSel({ kind: "page", entry: sel.entry, page: clamp(sel.page + by, book.entries[sel.entry].pages.length) });
    } else if (sel.kind === "entry") {
      // Entries are listed by their order number within a category.
      const e = book.entries[sel.index];
      const p = typeof e.priority === "number" ? e.priority : 0;
      update((b) => {
        const entries = [...b.entries];
        entries[sel.index] = { ...e, priority: p + by };
        return { ...b, entries };
      });
    }
  };

  // ── Properties ────────────────────────────────────────────────────────────

  const target: { title: string; obj: Obj; fields: Field[]; set: (o: Obj) => void } = (() => {
    switch (sel.kind) {
      case "book":
        return { title: t("Book"), obj: book, fields: BOOK_FIELDS, set: (o) => update(() => o as Book) };
      case "category":
        return {
          title: t("Category"),
          obj: book.categories[sel.index] ?? {},
          fields: CATEGORY_FIELDS,
          set: (o) => update((b) => ({ ...b, categories: b.categories.map((c, i) => (i === sel.index ? (o as typeof c) : c)) })),
        };
      case "entry":
        return {
          title: t("Entry"),
          obj: book.entries[sel.index] ?? {},
          fields: ENTRY_FIELDS,
          set: (o) => update((b) => ({ ...b, entries: b.entries.map((e, i) => (i === sel.index ? (o as typeof e) : e)) })),
        };
      case "page": {
        const page = book.entries[sel.entry]?.pages[sel.page] ?? { type: "text" };
        return {
          title: t("Page {n}", { n: sel.page + 1 }),
          obj: page,
          fields: pageFields(page.type),
          set: (o) =>
            update((b) => {
              const entries = [...b.entries];
              const pages = entries[sel.entry].pages.map((p, i) => (i === sel.page ? (o as Page) : p));
              entries[sel.entry] = { ...entries[sel.entry], pages };
              return { ...b, entries };
            }),
        };
      }
    }
  })();

  /** A field as an inspector row: how the book's value is edited and written back. */
  const property = (f: Field): PropertyDescriptor => {
    const v = target.obj[f.key];
    const set = (value: Json | undefined) => target.set(withField(target.obj, f.key, value));
    const id = typeof v === "string" ? refId(v) : "";
    const image =
      id && !id.startsWith("@")
        ? f.kind === "item"
          ? imagePreview(path, iconSource(id)) ?? undefined
          : f.kind === "entity"
            ? imagePreview(path, `item:${id}_spawn_egg`) ?? undefined
            : f.kind === "image"
              ? imagePreview(path, id) ?? undefined
              : undefined
        : undefined;
    // `@Book.title`: shown as the book shows it, the reference a click away.
    const shown = typeof v === "string" && v.startsWith("@") && shownText(v) !== v ? `${shownText(v)}  ‹${v}›` : undefined;
    const base = { id: f.key, name: pt("book", f.label), category: t(f.group ?? "Content"), readOnly };
    switch (f.kind) {
      case "multiline":
        return { ...base, kind: "text", value: str(v), displayValue: shown, onCommit: (x) => set(String(x)) };
      case "list":
        return {
          ...base,
          kind: "text",
          description: t("One per line."),
          value: Array.isArray(v) ? v.map(str).join("\n") : "",
          onCommit: (x) => set(String(x).split("\n").map((l) => l.trim()).filter(Boolean)),
        };
      case "number":
        return { ...base, kind: "number", value: typeof v === "number" ? v : null, onCommit: (x) => set(Number(x)) };
      case "bool":
        return { ...base, value: v === true, onCommit: (x) => set(x === true ? true : undefined) };
      case "color": {
        // A number (ARGB) or text (`RRGGBB`, `#RRGGBB`), kept as written.
        const digits = (x: string) => x.trim().replace(/^#|^0x/i, "");
        const text = typeof v === "number" ? `#${(v >>> 0).toString(16).toUpperCase().padStart(8, "0")}` : str(v);
        const d = digits(text);
        const swatch = /^[0-9a-f]{6}$/i.test(d) ? `#${d}` : /^[0-9a-f]{8}$/i.test(d) ? `#${d.slice(2)}${d.slice(0, 2)}` : undefined;
        return {
          ...base,
          value: text,
          swatch,
          validate: (x) => (/^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(digits(String(x))) ? null : t("Not a colour: #RRGGBB or #AARRGGBB.")),
          onCommit: (x) => set(typeof v === "number" ? parseInt(digits(String(x)), 16) >>> 0 : String(x).trim()),
        };
      }
      default:
        return { ...base, value: str(v), displayValue: shown, image, onCommit: (x) => set(String(x) || undefined) };
    }
  };

  const properties: PropertyDescriptor[] = [
    ...(sel.kind === "page"
      ? [
          {
            id: "type",
            name: t("Type"),
            category: t("Content"),
            readOnly,
            value: str(target.obj.type),
            options: PAGE_TYPES.map((p) => p.type),
            optionLabel: (type: string) => t(PAGE_TYPES.find((p) => p.type === type)?.label ?? type),
            onCommit: (x: PropertyValue) => target.set({ ...newPage(String(x)), ...keep(target.obj, String(x)) }),
          } satisfies PropertyDescriptor,
        ]
      : []),
    ...(sel.kind === "category" || sel.kind === "entry"
      ? [{ id: "id", name: t("Id"), category: t("Content"), readOnly, value: str(target.obj.id), onCommit: (x: PropertyValue) => target.set({ ...target.obj, id: String(x) }) }]
      : []),
    ...target.fields.map(property),
  ];

  const headerIcon = typeof target.obj.icon === "string" ? refId(target.obj.icon) : "";
  shownProperties.current = {
    header:
      (sel.kind === "category" || sel.kind === "entry") && headerIcon && !headerIcon.startsWith("@") ? (
        <ItemHeader path={path} item={headerIcon} caption={shownText(str(target.obj.name)) || target.title} />
      ) : undefined,
    order: "declared",
    objectName: target.title,
    objectKey: JSON.stringify(sel),
    objectDescription: t("Texts may refer to resources: @Strings.key, @item:mymod:ruby, @block:stone."),
    properties,
  };

  // ── Outline ───────────────────────────────────────────────────────────────

  const is = (s: Selection) => JSON.stringify(s) === JSON.stringify(sel);
  const row = (s: Selection, label: string, depth: number, icon?: string) => {
    const iconId = icon ? refId(icon) : "";
    const shownIcon = iconId && !iconId.startsWith("@") ? imagePreview(path, iconSource(iconId)) : null;
    return (
      <button key={JSON.stringify(s)} type="button" className={`book-row${is(s) ? " selected" : ""}`} style={{ paddingLeft: 6 + depth * 14 }} onClick={() => select(s)}>
        {shownIcon ? <img src={shownIcon} alt="" /> : <span className="book-row-dot" />}
        <span className="book-row-label">{shownText(label) || t("(unnamed)")}</span>
      </button>
    );
  };
  const pageLabel = (p: Page, n: number) => {
    const kind = t(PAGE_TYPES.find((x) => x.type === p.type)?.label ?? p.type);
    const what = shownText(str(p.title ?? p.name ?? p.text ?? p.item ?? p.entity ?? "")).split("\n")[0];
    return `${n + 1}. ${kind}${what ? ` — ${what}` : ""}`;
  };

  return (
    <div className="book-editor">
      <Toolbar>
        <ToolbarGroup>
          <ToolbarButton icon="plus" label="Category" showLabel disabled={readOnly} onClick={addCategory} />
          <ToolbarButton icon="plus" label="Entry" showLabel disabled={readOnly || book.categories.length === 0} onClick={addEntry} />
          <ToolbarSelect
            value=""
            disabled={readOnly || entryOfSelection() === undefined}
            options={[{ value: "", label: t("+ Page…") }, ...PAGE_TYPES.map((p) => ({ value: p.type, label: t(p.label) }))]}
            onChange={(v) => v && addPage(v)}
          />
        </ToolbarGroup>
        <ToolbarGroup>
          <ToolbarSelect
            label="Language"
            value={locale}
            options={[{ value: "", label: t("Neutral") }, ...(rendered?.locales ?? []).map((l) => ({ value: l, label: l }))]}
            onChange={setLocale}
          />
        </ToolbarGroup>
        <Spacer />
        <ToolbarGroup>
          <ToolbarButton icon="arrowUp" label="Move up" disabled={readOnly || sel.kind === "book"} onClick={() => move(-1)} />
          <ToolbarButton icon="arrowDown" label="Move down" disabled={readOnly || sel.kind === "book"} onClick={() => move(1)} />
          <ToolbarButton icon="trash" label="Delete" disabled={readOnly || sel.kind === "book"} onClick={remove} />
        </ToolbarGroup>
      </Toolbar>
      <div className="book-body">
        <div className="book-outline">
          {row({ kind: "book" }, str(book.name) || book.id, 0)}
          {book.categories.map((c, ci) => (
            <div key={c.id + ci}>
              {row({ kind: "category", index: ci }, str(c.name), 1, str(c.icon))}
              {entriesOf(book, c.id).map(({ entry, index }) => (
                <div key={entry.id + index}>
                  {row({ kind: "entry", index }, str(entry.name), 2, str(entry.icon))}
                  {(sel.kind === "entry" && sel.index === index) || (sel.kind === "page" && sel.entry === index)
                    ? entry.pages.map((p, pi) => row({ kind: "page", entry: index, page: pi }, pageLabel(p, pi), 3))
                    : null}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="book-preview">
          {rendered?.image ? (
            <img
              src={rendered.image}
              alt=""
              style={{ width: SCREEN_W * 2, height: SCREEN_H * 2 }}
              onClick={onPreviewClick}
              draggable={false}
            />
          ) : (
            <div className="book-preview-empty">{rendered?.error ?? t("Drawing…")}</div>
          )}
          {rendered?.image && rendered.error && <div className="book-preview-error">{rendered.error}</div>}
          <div className="book-preview-hint">{t("Click the book like a reader would — entries, page arrows, home.")}</div>
        </div>
      </div>
    </div>
  );
}

/** A text as the book shows it: `@Set.key` from the .yres files, `@item:`/`@block:` as a name. */
function shownText(v: string): string {
  const id = /^@(?:item|block):(.+)$/.exec(v)?.[1];
  if (id) {
    const path = id.split(":").pop() ?? id;
    return path.split("/").pop()!.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }
  return designText(v);
}

/** What a page keeps when its type changes: its texts. */
function keep(page: Obj, type: string): Obj {
  const fields = pageFields(type).map((f) => f.key);
  return Object.fromEntries(Object.entries(page).filter(([k]) => k !== "type" && fields.includes(k)));
}

function str(v: Json | undefined): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function ns(id: string): string {
  return id.includes(":") ? id.split(":")[0] : "mod";
}

function clamp(i: number, len: number): number {
  return Math.max(0, Math.min(len - 1, i));
}
