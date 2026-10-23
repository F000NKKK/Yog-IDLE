// Tabs kept in step with the disk: reloaded when their files change, unless they have edits.

import { useCallback, useEffect, useRef } from "react";
import { forgetDocumentHistory, notify, t, useFilesChanged, useWatchedFolders } from "substrate-platform-ui";
import { files } from "../project/files";
import { parentOf } from "../project/paths";
import type { OpenTabs } from "./tabs/useOpenTabs";
import type { TabPaths } from "./tabs/useTabPaths";

/** Tabs kept in step with the disk: reloaded when their files change, unless they have edits. */
export function useDiskRecheck(openTabs: OpenTabs, tabPaths: TabPaths) {
  const { tabs, setTabs, tabsRef } = openTabs;
  const { markGone } = tabPaths;
  // Something else (a terminal, git, another editor) may have changed open
  // files while the window was in the background: on focus, reload tabs
  // without edits, and only *tell* about ones with edits — never overwrite
  // unsaved work. Files that vanished are handled like an Explorer delete.
  const warnedDisk = useRef(new Map<string, string>());
  const recheckDisk = useCallback(async (only?: Set<string>) => {
    const vanished = new Set<string>();
    for (const tab of tabsRef.current) {
      if (only && !only.has(tab.path)) continue;
      // A binary file (an image) isn't compared: changed on disk, its view
      // is told to show it anew.
      if (!tab.textLoaded) {
        if (only) setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, contentVersion: t.contentVersion + 1 } : t)));
        continue;
      }
      let disk: string;
      try {
        disk = await files.read(tab.path);
      } catch {
        vanished.add(tab.id);
        continue;
      }
      const current = tabsRef.current.find((t) => t.id === tab.id);
      if (!current) continue;
      if (disk === current.diskContent) {
        // Back again (restored by git, say) — no longer "deleted".
        if (current.missing) setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, missing: false } : t)));
        continue;
      }
      if (!current.dirty) {
        // Changed on disk: steps from before don't apply to it.
        forgetDocumentHistory(tab.path);
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tab.id && !t.dirty ? { ...t, content: disk, diskContent: disk, missing: false, contentVersion: t.contentVersion + 1 } : t
          )
        );
      } else if (warnedDisk.current.get(tab.id) !== disk) {
        warnedDisk.current.set(tab.id, disk);
        notify({ level: "warn", message: t("{name} changed on disk — your unsaved changes are kept; saving will overwrite the file.", { name: current.name }) });
      }
    }
    if (vanished.size > 0) markGone((t) => vanished.has(t.id));
  }, [markGone]);
  useEffect(() => {
    const recheck = () => void recheckDisk();
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [recheckDisk]);
  // ...and while it's in front too: the open files' folders are watched (a
  // folder, not the file — editors that save by replacing the file would
  // leave a file watch behind).
  useWatchedFolders("open-files", tabs.map((t) => parentOf(t.path)));
  useFilesChanged((paths) => void recheckDisk(new Set(paths)));

  return { warnedDisk, recheckDisk };
}

/** What `useDiskRecheck` gives the component. */
export type DiskRecheck = ReturnType<typeof useDiskRecheck>;
