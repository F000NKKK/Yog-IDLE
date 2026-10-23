import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useT } from "substrate-platform-ui";
import { useOpenFiles } from "../openFiles/OpenFilesContext";
import { samePath } from "../project/paths";
import { evaluate, fetchLocals, identifiers, type Variable, type WatchResult } from "./variables";
import { VariablesTree, type RootRow } from "./VariablesTree";
import { useWatches } from "./WatchesContext";
import { files } from "../project/files";

type Expanded = [ReadonlySet<string>, Dispatch<SetStateAction<ReadonlySet<string>>>];

/** The selected frame's locals, re-queried on every stop (`stopKey`) and frame switch; `frame` is the frame's id. */
export function useLocals(stopKey: unknown, frame: number | null): { locals: Variable[] | null; error: string | null } {
  const [state, setState] = useState<{ locals: Variable[] | null; error: string | null }>({ locals: null, error: null });
  useEffect(() => {
    if (frame === null) {
      setState({ locals: [], error: null });
      return;
    }
    let current = true;
    fetchLocals(frame)
      .then((locals) => current && setState({ locals, error: null }))
      .catch((err) => current && setState({ locals: null, error: String(err) }));
    return () => {
      current = false;
    };
  }, [stopKey, frame]);
  return state;
}

const rootsOf = (vars: Variable[], prefix: string): RootRow[] =>
  vars.map((v, i) => ({ key: `${prefix}${i}:${v.name}`, name: v.name, variable: v }));

/** Visual Studio's Locals window. */
export function LocalsView({ locals, error, expanded }: { locals: Variable[] | null; error: string | null; expanded: Expanded }) {
  const t = useT();
  if (error) return <div className="yi-vt-empty">{error}</div>;
  if (!locals) return <div className="yi-vt-empty">{t("Loading…")}</div>;
  return (
    <VariablesTree
      roots={rootsOf(locals, "")}
      expanded={expanded[0]}
      onExpandedChange={expanded[1]}
      emptyText={t("No locals in this frame.")}
    />
  );
}

/**
 * Visual Studio's Autos window: the locals used on the line the frame is
 * stopped at and the one before it, in the order they appear there.
 */
export function AutosView({ locals, file, line, expanded }: { locals: Variable[] | null; file: string | null; line: number | null; expanded: Expanded }) {
  const t = useT();
  const text = useSourceText(file);
  if (!locals) return <div className="yi-vt-empty">{t("Loading…")}</div>;
  const lines = text?.split("\n") ?? [];
  const used = line === null ? [] : identifiers([lines[line - 2] ?? "", lines[line - 1] ?? ""].join("\n"));
  // Shadowed names: the innermost (last listed) binding is the visible one.
  const byName = new Map(locals.map((v) => [v.name, v]));
  const autos = used.flatMap((name) => {
    const v = byName.get(name);
    return v ? [v] : [];
  });
  return (
    <VariablesTree roots={rootsOf(autos, "")} expanded={expanded[0]} onExpandedChange={expanded[1]} emptyText={t("No variables used here.")} />
  );
}

/** A source file's text: the open tab's (possibly unsaved) content, else read from disk. */
function useSourceText(file: string | null): string | null {
  const { tabs } = useOpenFiles();
  const open = file ? tabs.find((tab) => samePath(tab.path, file)) : undefined;
  const [disk, setDisk] = useState<{ file: string; text: string } | null>(null);
  useEffect(() => {
    if (!file || open) return;
    let current = true;
    files.read(file)
      .then((text) => current && setDisk({ file, text }))
      .catch(() => current && setDisk({ file, text: "" }));
    return () => {
      current = false;
    };
  }, [file, open]);
  if (open) return open.content;
  return disk && disk.file === file ? disk.text : null;
}

/**
 * Visual Studio's Watch window: the project's watch expressions evaluated
 * in the selected frame on every stop. Type in the last row to add one,
 * double-click (or F2) to edit, Delete to remove; one that doesn't
 * evaluate shows why in red.
 */
export function WatchView({ stopKey, frame, expanded }: { stopKey: unknown; frame: number | null; expanded: Expanded }) {
  const { watches, add, edit, remove } = useWatches();
  const [results, setResults] = useState<{ exprs: string[]; values: WatchResult[] } | null>(null);
  useEffect(() => {
    if (frame === null) return;
    let current = true;
    evaluate(frame, watches).then((values) => current && setResults({ exprs: watches, values }));
    return () => {
      current = false;
    };
  }, [stopKey, frame, watches]);

  const roots: RootRow[] = watches.map((expr, i) => {
    const result = results && results.exprs[i] === expr ? results.values[i] : undefined;
    return {
      // Keyed by position and text, so editing a watch drops its expansion.
      key: `${i}:${expr}`,
      name: expr,
      variable: result?.value ?? null,
      error: result ? result.error : null,
    };
  });
  return <VariablesTree roots={roots} expanded={expanded[0]} onExpandedChange={expanded[1]} onEditRoot={edit} onDeleteRoot={remove} onAdd={add} />;
}
