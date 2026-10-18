import { useEffect, useMemo, useState } from "react";
import { Button, PropertyGrid, useT, type EditorProps } from "substrate-platform-ui";
import { cli } from "../cli";
import { useDataFile, type DataFormat } from "../data/useDataFile";
import { readObject } from "../data/yogData";
import { kind as KIND } from "../data/yogIds.generated";
import { shapeProperties, type Described } from "../data/shapeGrid";
import { useOpenFiles } from "../OpenFilesContext";
import { TerrainPreview } from "./TerrainPreview";
import "./DataEditor.css";
import { formats } from "../yogFileTypes";

/** Any Yog format's file: one object. */
const OBJECT: DataFormat<Record<string, unknown>> = { read: readObject<Record<string, unknown>> };

const shapes = new Map<string, Promise<Described>>();

/** The schema of `format`, asked once (the CLI's `format.shape`, the build's own). */
export function formatShape(format: string): Promise<Described> {
  let p = shapes.get(format);
  if (!p) {
    p = cli<Described>("format.shape", { format });
    shapes.set(format, p);
  }
  return p;
}

/**
 * A file of a Yog format as a property grid generated from its schema —
 * for formats without a designer of their own (`.ydef`, a
 * recipe of a kind the crafting table doesn't lay out). `sourceView` is
 * the code view View Code switches to.
 */
export function DataEditor({ path, content, onChange, readOnly, format, sourceView }: EditorProps & { format: string; sourceView: string }) {
  const t = useT();
  const [shape, setShape] = useState<Described | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { tabs, setView } = useOpenFiles();
  useEffect(() => {
    let live = true;
    formatShape(format).then(
      (s) => live && setShape(s),
      (e) => live && setError(String(e))
    );
    return () => {
      live = false;
    };
  }, [format]);
  const { parsed, update } = useDataFile(content, onChange, OBJECT, readOnly);
  const viewCode = () => {
    const tab = tabs.find((x) => x.path === path);
    if (tab) void setView(tab.id, sourceView);
  };
  const properties = useMemo(() => {
    if (!shape || !parsed?.ok) return [];
    const rows = shapeProperties(shape, parsed.file, (next) => void update(() => next), t);
    return readOnly ? rows.map((r) => ({ ...r, readOnly: true })) : rows;
  }, [shape, parsed, update, readOnly, t]);

  if (!parsed) return null;
  if (error || !parsed.ok) {
    return (
      <div className="data-editor data-editor-broken">
        <p>{error ?? t("This file has a mistake: {error}", { error: parsed.ok ? "" : parsed.error })}</p>
        <Button onClick={viewCode}>{t("View Code")}</Button>
      </div>
    );
  }
  // A dimension with a terrain: the ground it makes, beside its properties.
  const terrain = format === formats.def.ext && parsed.file.kind === KIND.DIMENSION && parsed.file.terrain !== undefined;
  return (
    <div className="data-editor">
      <div className="data-editor-body">
        <PropertyGrid objectName={path.split(/[\\/]/).pop()} objectType={format} objectKey={path} properties={properties} persistKey={`yog.data.${format}`} />
        {terrain && <TerrainPreview content={content} />}
      </div>
      <div className="data-editor-actions">
        <Button onClick={viewCode}>{t("View Code")}</Button>
      </div>
    </div>
  );
}
