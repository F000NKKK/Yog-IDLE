import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { EVENT, listenAll, listenTo } from "./events";

/**
 * Watching for changes made outside the IDE (a terminal, git, another
 * editor, a build). Each part of the IDE names the folders it shows —
 * the Project Explorer its listed folders, the editor its open files'
 * folders — and the backend watches their union; changes come back as
 * `fs-changed` batches.
 */

/** What each part wants watched. */
const wanted = new Map<string, string[]>();
let timer: ReturnType<typeof setTimeout> | undefined;
/** The union last sent, so an unchanged set isn't re-sent. */
let sent = "";

function sync() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const folders = [...new Set([...wanted.values()].flat())].sort();
    const key = folders.join("\n");
    if (key === sent) return;
    sent = key;
    invoke("fs_watch", { folders }).catch((e) => console.warn("fs_watch:", e));
  }, 50);
}

/** Watches `folders` while the calling component is mounted (`key` names its part). */
export function useWatchedFolders(key: string, folders: Iterable<string>) {
  const list = [...new Set(folders)].sort();
  const id = list.join("\n");
  useEffect(() => {
    wanted.set(key, id ? id.split("\n") : []);
    sync();
    return () => {
      wanted.delete(key);
      sync();
    };
  }, [key, id]);
}

/** Calls `handler` with each batch of paths changed outside the IDE. */
export function useFsChanged(handler: (paths: string[]) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => listenAll([listenTo(EVENT.fsChanged, (paths) => ref.current(paths))]), []);
}
