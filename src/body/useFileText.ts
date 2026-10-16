import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useFsChanged } from "../fsWatch";
import { useOpenFilesIfAny } from "../OpenFilesContext";

/**
 * The text of another file a designer shows (an entity's model, a clip's
 * skeleton): an open tab's — unsaved edits too — else what's on disk, read
 * again when it changes there; `null` until read, or when it can't be.
 */
export function useFileText(file: string | null): string | null {
  const open = useOpenFilesIfAny()?.tabs.find((t) => t.path === file && t.textLoaded);
  const [disk, setDisk] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  useFsChanged((paths) => {
    if (file && paths.includes(file)) setAsked((n) => n + 1);
  });
  useEffect(() => {
    if (!file) return setDisk(null);
    let live = true;
    invoke<string>("file_read", { path: file })
      .then((text) => live && setDisk(text ?? null))
      .catch(() => live && setDisk(null));
    return () => {
      live = false;
    };
  }, [file, asked]);
  return open ? open.content : disk;
}
