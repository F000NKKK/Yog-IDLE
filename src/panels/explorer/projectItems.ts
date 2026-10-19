import { useEffect, useState } from "react";
import type { DirEntry } from "substrate-platform-ui";
import { files } from "../../files";
import { useFilesChanged } from "substrate-platform-ui";

/** Outside changes this close together are one re-listing. */
const RELIST_DEBOUNCE_MS = 300;
/** Typing pauses this long before the file contents are searched. */
const CONTENT_SEARCH_DEBOUNCE_MS = 250;

/**
 * The project's own files and folders (`project_items`) — what search, the
 * filters and Show All Files go by — re-listed as files change on disk and
 * whenever `revision` does (the explorer's own creates, moves, deletes).
 */
export function useProjectItems(root: string, revision: number): DirEntry[] | null {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [changes, setChanges] = useState(0);
  useFilesChanged(() => setChanges((n) => n + 1));
  useEffect(() => {
    let live = true;
    const timer = setTimeout(
      () =>
        void files.projectItems(root).then(
          (list) => live && setEntries(list),
          () => live && setEntries(null)
        ),
      changes === 0 && revision === 0 ? 0 : RELIST_DEBOUNCE_MS
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [root, revision, changes]);
  return entries;
}

/** "Search within file contents": the files whose text contains `query` — `null` while off, blank, or not answered yet. */
export function useContentMatches(root: string, query: string, enabled: boolean, revision: number): ReadonlySet<string> | null {
  const [hits, setHits] = useState<{ key: string; paths: ReadonlySet<string> } | null>(null);
  const pattern = query.trim();
  const key = `${root}\u0000${pattern}`;
  useEffect(() => {
    if (!enabled || !pattern) return;
    let live = true;
    const timer = setTimeout(
      () =>
        void files.filesContaining(root, pattern).then(
          (paths) => live && setHits({ key, paths: new Set(paths) }),
          () => live && setHits({ key, paths: new Set() })
        ),
      CONTENT_SEARCH_DEBOUNCE_MS
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [root, pattern, key, enabled, revision]);
  return enabled && pattern && hits?.key === key ? hits.paths : null;
}
