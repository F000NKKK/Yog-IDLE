import { SelectField, Spacer, ToolbarButton } from "substrate-platform-ui";
import { cropFrame, stillAnimation } from "../../content/animation";
import { autoUv, DIRS } from "../../content/model";
import { FrameStrip } from "../../content/paint/FrameStrip";
import { PaintCanvas } from "../../content/paint/PaintCanvas";
import type { ContentView } from "./contentView";

/** A model texture's pixels per UV unit: a face's UVs run 0–16 across the (frame of the) texture. */
const UV_SPAN = 16;
/** Tools that paint with the brush's size; the rest paint single pixels. */
const SIZED_TOOLS: ReadonlySet<string> = new Set(["pencil", "eraser", "line"]);

/** The selected element's faces on the active slot's texture, outlined on the 2D canvas — the picked face as the primary one. */
function faceOverlays(view: ContentView, imgW: number, imgH: number) {
  const { selEl, face, resolved } = view.m;
  const { activeSlot, activeAnim } = view.pt;
  const overlays: { rect: [number, number, number, number]; primary?: boolean }[] = [];
  if (!activeSlot || !selEl || resolved.sprite) return overlays;
  const sx = (activeAnim?.frameWidth ?? imgW) / UV_SPAN;
  const sy = (activeAnim?.frameHeight ?? imgH) / UV_SPAN;
  for (const d of DIRS) {
    const f = selEl.faces[d];
    if (!f || f.texture.replace(/^#/, "") !== activeSlot) continue;
    const [u0, v0, u1, v1] = f.uv ?? autoUv(d, selEl.from, selEl.to);
    overlays.push({ rect: [u0 * sx, v0 * sy, u1 * sx, v1 * sy], primary: d === face });
  }
  return overlays;
}

/** Paint mode's 2D view: the texture of the slot painted (picked above it), the selected element's faces on it, and its animation's frames. */
export function PaintPane({ view }: { view: ContentView }) {
  const { readOnly } = view.props;
  const { t, resolved, setPaintSlot, images, paint, playing, setPlaying, setPaintEntry } = view.m;
  const { activeSlot, activeKey, activeAnim, activeEntry, activeFrame, paintSlots, editAnimation, onCanvasPaint } = view.pt;
  const activeImg = view.tx.pixelsOf(activeKey);
  const activeForeign = !!activeKey && !!images[activeKey] && !images[activeKey]?.writable;
  return (
    <div className="content-paint">
      <div className="content-pane-header">
        <SelectField aria-label={t("Texture")} value={activeSlot ?? ""} options={paintSlots.map((s) => ({ value: s, label: `${s}: ${resolved.textures[s]}` }))} onChange={(v) => setPaintSlot(v)} />
        {activeForeign && <span className="content-paint-note">{t("Not the mod's texture — the first stroke copies it into the mod.")}</span>}
        <Spacer />
        {activeKey && activeImg && !activeAnim && !activeForeign && (
          <ToolbarButton icon="play" label="Animate" showLabel tooltip="Make it an animated texture: frames, played in game (.png.mcmeta)" disabled={readOnly} onClick={() => editAnimation(activeKey, stillAnimation(activeImg))} />
        )}
      </div>
      <PaintCanvas
        className="content-paint-canvas"
        image={activeImg ? (activeAnim ? cropFrame(activeImg, activeAnim, activeFrame) : activeImg) : null}
        overlays={activeImg ? faceOverlays(view, activeImg.w, activeImg.h) : []}
        grid={paint.grid}
        brushSize={SIZED_TOOLS.has(paint.tool) ? paint.size : 1}
        mirrorX={paint.mirrorX}
        onPaint={readOnly ? undefined : onCanvasPaint}
        emptyText={activeKey ? t("Loading {texture}…", { texture: activeKey }) : t("No texture to paint. Use New Texture… or set a texture slot.")}
      />
      {activeKey && activeImg && activeAnim && (
        <FrameStrip
          image={activeImg}
          animation={activeAnim}
          selected={activeEntry}
          onSelect={(n) => setPaintEntry((m) => ({ ...m, [activeKey]: n }))}
          playing={playing}
          onPlaying={setPlaying}
          onChange={(animation, img) => editAnimation(activeKey, animation, img)}
          readOnly={readOnly || activeForeign}
        />
      )}
    </div>
  );
}
