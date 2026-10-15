import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toolbar, ToolbarSelect, useT } from "substrate-platform-ui";

interface Preview {
  top: string;
  slice: string;
  slice_top: number;
  slice_bottom: number;
}

/**
 * A `.ydef` dimension's `terrain` as the game generates it — the runtime's
 * own generator (`worldgen_preview`), from above around 0, 0 and in a slice
 * along x through the middle.
 */
export function TerrainPreview({ content }: { content: string }) {
  const t = useT();
  const [size, setSize] = useState(256);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      invoke<Preview>("worldgen_preview", { text: content, size }).then(
        (p) => {
          if (!live) return;
          setPreview(p);
          setError(null);
        },
        (e) => live && setError(String(e))
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [content, size]);
  return (
    <div className="terrain-preview">
      <Toolbar>
        <ToolbarSelect
          label="Terrain"
          value={String(size)}
          options={[64, 128, 256, 512].map((s) => ({ value: String(s), label: t("{size}×{size} blocks", { size: String(s) }) }))}
          onChange={(v) => setSize(Number(v))}
        />
      </Toolbar>
      {error && <p className="terrain-preview-error">{error}</p>}
      {preview && (
        <>
          <img className="terrain-preview-top" src={preview.top} alt={t("From above")} title={t("From above, around 0, 0")} />
          <img
            className="terrain-preview-slice"
            src={preview.slice}
            alt={t("Slice")}
            title={t("A slice along x at z = 0, y {top} to {bottom}", { top: String(preview.slice_top), bottom: String(preview.slice_bottom) })}
          />
        </>
      )}
    </div>
  );
}
