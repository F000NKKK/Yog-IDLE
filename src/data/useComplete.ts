import { useEffect, useState } from "react";
import { serveMethod } from "./yogIds.generated";
import { cli } from "../cli";

// A file's data with every field it leaves out at its default — what the
// game takes, read through the format's schema by the CLI
// (`format.complete`) — for a designer's preview and inspector, so no
// default is spelled twice.

/** `file` (data of format `ext`) completed; its last good completion while one fails, and why. */
export function useComplete<T>(file: object | null, ext: string): { complete: T | null; error: string | null } {
  const [out, setOut] = useState<{ complete: T | null; error: string | null }>({ complete: null, error: null });
  useEffect(() => {
    if (!file) return;
    let live = true;
    cli<T>(serveMethod.FORMAT_COMPLETE, { format: ext, value: file }).then(
      (complete) => live && setOut({ complete, error: null }),
      (e) => live && setOut((o) => ({ complete: o.complete, error: String((e as { message?: string })?.message ?? e) })),
    );
    return () => {
      live = false;
    };
  }, [file, ext]);
  return out;
}
