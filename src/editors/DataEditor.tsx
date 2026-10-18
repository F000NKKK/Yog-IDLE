import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, PropertyGrid, useT, type EditorProps } from "substrate-platform-ui";
import { DataSyntaxError, parseDataValue } from "../data/yogData";
import { shapeProperties, type Described } from "../data/shapeGrid";
import { useOpenFiles } from "../OpenFilesContext";
import { TerrainPreview } from "./TerrainPreview";
import "./DataEditor.css";
import { formats } from "../yogFileTypes";

const shapes = new Map<string, Promise<Described>>();

/** The schema of `format`, asked once (`format_shape`, the build's own). */
export function formatShape(format: string): Promise<Described> {
  let p = shapes.get(format);
  if (!p) {
    p = invoke<Described>("format_shape", { format });
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
  const parsed = useMemo(() => {
    if (content.trim() === "") return { ok: true as const, value: {} as Record<string, unknown> };
    try {
      const v = parseDataValue(content);
      if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false as const, error: t("The file must be one object.") };
      return { ok: true as const, value: v as Record<string, unknown> };
    } catch (e) {
      return { ok: false as const, error: e instanceof DataSyntaxError ? `${e.line}:${e.col}: ${e.message}` : String(e) };
    }
  }, [content, t]);
  const viewCode = () => {
    const tab = tabs.find((x) => x.path === path);
    if (tab) void setView(tab.id, sourceView);
  };
  const properties = useMemo(() => {
    if (!shape || !parsed.ok) return [];
    const rows = shapeProperties(shape, parsed.value, (next) => onChange(`${JSON.stringify(next, null, 2)}\n`), t);
    return readOnly ? rows.map((r) => ({ ...r, readOnly: true })) : rows;
  }, [shape, parsed, onChange, readOnly, t]);

  if (error || !parsed.ok) {
    return (
      <div className="data-editor data-editor-broken">
        <p>{error ?? t("This file has a mistake: {error}", { error: parsed.ok ? "" : parsed.error })}</p>
        <Button onClick={viewCode}>{t("View Code")}</Button>
      </div>
    );
  }
  // A dimension with a terrain: the ground it makes, beside its properties.
  const terrain = format === formats.def.ext && parsed.value.kind === "dimension" && parsed.value.terrain !== undefined;
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
