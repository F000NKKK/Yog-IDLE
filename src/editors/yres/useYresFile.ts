// The file: its parsed entries, where it sits in its set, the grid's state, and edits to its text.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type DataGridHandle, type EditorProps, useLocale, useT } from "substrate-platform-ui";
import { useOpenFiles } from "../../openFiles/OpenFilesContext";
import { parseYres, serializeYres, splitYresPath, type YresEntry, type YresParse } from "../../lang/yres";
import { type Row, SHOW_ALL_KEY, type Sibling } from "./yresModel";

/** The file: its parsed entries, where it sits in its set, the grid's state, and edits to its text. */
export function useYresFile(props: EditorProps) {
  const { path, content, onChange, readOnly } = props;
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

  return { t, locale, tabs, updateContent, setView, parsed, setParsed, entries, dir, set, ownLocale, sep, isCulture, query, setQuery, showAll, setShowAll, selected, setSelected, siblings, setSiblings, gridRef, rootRef, activeRef, contentRef, apply };
}

/** What `useYresFile` gives the component. */
export type YresFile = ReturnType<typeof useYresFile>;
