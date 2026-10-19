import { errorText } from "substrate-platform-ui";
// A Yog Data file as a designer edits it: read through the CLI, shown as
// the designer last changed it, and written back edit by edit — each on
// the text the one before left, so quick edits (a drag) never undo each
// other while the CLI writes.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { reportError } from "../reportError";
import { patchData, type Read } from "./yogData";

/** The file as a designer sees it: `undefined` while it's first read. */
export type Parsed<T> = { ok: true; file: T } | { ok: false; error: string } | undefined;

export interface DataFile<T> {
  parsed: Parsed<T>;
  /**
   * Changes the file: `edit` gets a copy to change (or returns the new
   * file). Resolves once the text is written.
   */
  update: (edit: (draft: T) => T | void) => Promise<void>;
}

/** What `read` makes of `text` (`null`: no text): `undefined` until it's read; the last result while a new text is. */
export function useRead<T>(text: string | null, read: (text: string) => Promise<T>): T | undefined {
  const [last, setLast] = useState<{ value: T }>();
  useEffect(() => {
    if (text === null) {
      setLast(undefined);
      return;
    }
    let live = true;
    void read(text).then((value) => live && setLast({ value }));
    return () => {
      live = false;
    };
  }, [text, read]);
  return last?.value;
}

/** How a file is read, and how a changed one is written into its text. */
export interface DataFormat<T> {
  read: (text: string) => Promise<Read<T>>;
  write?: (text: string, next: T) => Promise<string>;
}

export function useDataFile<T>(content: string, onChange: (text: string) => void, format: DataFormat<T>, readOnly = false): DataFile<T> {
  const { read, write = patchData } = format;
  const [last, setLast] = useState<{ text: string; read: Read<T> }>();
  useEffect(() => {
    let live = true;
    void read(content).then((r) => live && setLast({ text: content, read: r }));
    return () => {
      live = false;
    };
  }, [content, read]);

  // The text the last write left, the writes under way, and the file as last changed.
  const latest = useRef(content);
  const pending = useRef(0);
  const model = useRef<T | undefined>(undefined);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  if (pending.current === 0) {
    latest.current = content;
    // What's on disk now is the file — unless a newer text is still being read.
    if (last?.read.ok && last.text === content) model.current = last.read.value;
  }

  const update = useCallback(
    (edit: (draft: T) => T | void): Promise<void> => {
      const base = model.current;
      if (readOnly || base === undefined) return Promise.resolve();
      const draft = structuredClone(base);
      const next = (edit(draft) ?? draft) as T;
      model.current = next;
      pending.current++;
      rerender();
      const done = chain.current
        .then(async () => {
          const text = await write(latest.current, next);
          if (text !== latest.current) {
            latest.current = text;
            onChange(text);
          }
        })
        .catch((e: unknown) => reportError(errorText(e)))
        .finally(() => {
          pending.current--;
        });
      chain.current = done;
      return done;
    },
    [onChange, readOnly, write],
  );

  const file = model.current;
  const showEdited = pending.current > 0 || !!last?.read.ok;
  const parsed = useMemo<Parsed<T>>(() => {
    if (!last) return undefined;
    if (file !== undefined && showEdited) return { ok: true, file };
    return last.read.ok ? { ok: true, file: last.read.value } : { ok: false, error: last.read.error };
  }, [last, file, showEdited]);
  return { parsed, update };
}
