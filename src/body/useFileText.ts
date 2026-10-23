import { useEffect, useState } from "react";
import { useOpenFilesIfAny } from "../openFiles/OpenFilesContext";
import { useFilesChanged } from "substrate-platform-ui";
import { files } from "../project/files";

/**
 * The text of another file a designer shows (an entity's model, a clip's
 * skeleton): an open tab's — unsaved edits too — else what's on disk, read
 * again when it changes there; `null` until read, or when it can't be.
 */
export function useFileText(file: string | null): string | null {
  const open = useOpenFilesIfAny()?.tabs.find((t) => t.path === file && t.textLoaded);
  const [disk, setDisk] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  useFilesChanged((paths) => {
    if (file && paths.includes(file)) setAsked((n) => n + 1);
  });
  useEffect(() => {
    if (!file) return setDisk(null);
    let live = true;
    files.read(file)
      .then((text) => live && setDisk(text ?? null))
      .catch(() => live && setDisk(null));
    return () => {
      live = false;
    };
  }, [file, asked]);
  return open ? open.content : disk;
}
