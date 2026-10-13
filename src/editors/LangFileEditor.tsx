import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DataGrid, useLocale, useT, type DataGridColumn, type EditorProps } from "substrate-platform-ui";

/** One `"key": "value"` entry, with where its two string literals sit in the file's text. */
interface LangEntry {
  id: string;
  key: string;
  value: string;
  keyRange: [number, number];
  valueRange: [number, number];
  /** The same key's text in `en_us.json`, when this isn't that file. */
  reference?: string;
}

/**
 * Reads a Minecraft lang file — one flat JSON object of string values —
 * keeping each literal's offsets so an edit can splice just that literal
 * back in. `null` if the text isn't such an object (mid-edit in the Code
 * view, say).
 */
function scanLangFile(text: string): LangEntry[] | null {
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && /[\s﻿]/.test(text[i])) i++;
  };
  const readString = (): [number, number] | null => {
    if (text[i] !== '"') return null;
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    if (i >= text.length) return null;
    return [start, ++i];
  };
  const literal = ([from, to]: [number, number]): string => JSON.parse(text.slice(from, to));

  const entries: LangEntry[] = [];
  skipSpace();
  if (text[i++] !== "{") return null;
  try {
    for (;;) {
      skipSpace();
      if (text[i] === "}") break;
      const keyRange = readString();
      if (!keyRange) return null;
      skipSpace();
      if (text[i++] !== ":") return null;
      skipSpace();
      const valueRange = readString();
      if (!valueRange) return null;
      entries.push({ id: String(entries.length), key: literal(keyRange), value: literal(valueRange), keyRange, valueRange });
      skipSpace();
      if (text[i] === ",") i++;
      else if (text[i] !== "}") return null;
    }
  } catch {
    return null;
  }
  return entries;
}

/** `assets/<namespace>/lang/<locale>.json` — what Minecraft loads translations from. */
export function isLangFile(path: string): boolean {
  return /[\\/]assets[\\/][^\\/]+[\\/]lang[\\/][^\\/]+\.json$/i.test(path);
}

const REFERENCE_LOCALE = "en_us";

/**
 * A designer for Minecraft lang files, like Visual Studio's `.resx` grid:
 * keys and texts in an editable table, next to the `en_us` text being
 * translated. Lossless — an edit rewrites only that one string literal, so
 * the file's formatting and order stay exactly as they were.
 */
export function LangFileEditor({ path, content, onChange, readOnly }: EditorProps) {
  const t = useT();
  const locale = useLocale();
  const entries = useMemo(() => scanLangFile(content), [content]);
  const separator = path.includes("\\") ? "\\" : "/";
  const dir = path.slice(0, path.lastIndexOf(separator));
  const isReference = path.slice(dir.length + 1).toLowerCase() === `${REFERENCE_LOCALE}.json`;

  const [reference, setReference] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    if (isReference) return;
    let cancelled = false;
    files.read(`${dir}${separator}${REFERENCE_LOCALE}.json`)
      .then((text) => {
        const scanned = scanLangFile(text);
        if (!cancelled && scanned) setReference(new Map(scanned.map((e) => [e.key, e.value])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dir, separator, isReference]);

  const columns = useMemo<DataGridColumn<LangEntry>[]>(
    () => [
      { key: "key", header: t("Key"), width: 280, sortable: true, editable: true, sortValue: (e) => e.key },
      ...(reference ? [{ key: "reference", header: REFERENCE_LOCALE, width: 260, sortable: true, sortValue: (e: LangEntry) => e.reference ?? "" }] : []),
      { key: "value", header: t("Text"), width: 320, sortable: true, editable: true, sortValue: (e) => e.value },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reference, locale]
  );

  if (!entries) {
    return <div style={{ padding: "var(--sp-space-md)" }}>{t("Not a flat JSON object of strings — fix it in the Code view.")}</div>;
  }
  const rows = reference ? entries.map((e) => ({ ...e, reference: reference.get(e.key) })) : entries;

  function commitEdit(entry: LangEntry, column: string, text: string) {
    if (readOnly || (column !== "key" && column !== "value")) return;
    const [from, to] = column === "key" ? entry.keyRange : entry.valueRange;
    onChange(content.slice(0, from) + JSON.stringify(text) + content.slice(to));
  }

  return (
    <div style={{ height: "100%", boxSizing: "border-box" }}>
      <DataGrid className="sp-datagrid--flush" columns={columns} rows={rows} getRowId={(e) => e.id} onCellEditCommit={commitEdit} filterRow />
    </div>
  );
}
