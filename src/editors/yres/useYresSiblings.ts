// The other files of the set (neutral and cultures): loaded, watched, written.

import { useCallback, useEffect, useRef } from "react";
import { type DirEntry, type EditorProps, reportError } from "substrate-platform-ui";
import { files } from "../../files";
import { parseYres, serializeYres, splitYresPath, textMap, type YresEntry } from "../../lang/yres";
import type { YresFile } from "./useYresFile";
import type { Sibling } from "./yresModel";

/** The other files of the set (neutral and cultures): loaded, watched, written. */
export function useYresSiblings(props: EditorProps, yresFile: YresFile) {
  const { path, readOnly } = props;
  const { t, tabs, updateContent, dir, set, isCulture, showAll, siblings, setSiblings } = yresFile;
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

  return { tabsRef, loadSiblings, writeSibling, neutral, shownSiblings, editableSibling };
}

/** What `useYresSiblings` gives the component. */
export type YresSiblings = ReturnType<typeof useYresSiblings>;
