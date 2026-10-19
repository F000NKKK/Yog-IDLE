import { Button, Icon, IconButton, Spacer } from "substrate-platform-ui";
import { layerIndex } from "../contentModel";
import type { ContentView } from "../contentView";

/** An item sprite's layers: their textures, tint previews, order — and converting the sprite to elements. */
export function LayersPanel({ view }: { view: ContentView }) {
  const { readOnly } = view.props;
  const { t, resolved, setPaintSlot } = view.m;
  const { activeSlot, layers, addLayer, removeLayer, moveLayer, shownImages, convertToElements } = view.pt;
  const index = activeSlot ? layerIndex(activeSlot) : -1;
  return (
    <>
      <div className="content-pane-header">
        <span>{t("Layers")}</span>
        <Spacer />
        <IconButton title={t("Add Layer")} disabled={readOnly} onClick={addLayer}>
          <Icon name="plus" />
        </IconButton>
        <IconButton title={t("Move Up")} disabled={readOnly || !activeSlot || index <= 0} onClick={() => activeSlot && moveLayer(activeSlot, -1)}>
          <Icon name="arrowUp" />
        </IconButton>
        <IconButton title={t("Move Down")} disabled={readOnly || !activeSlot || index < 0 || index >= layers.length - 1} onClick={() => activeSlot && moveLayer(activeSlot, 1)}>
          <Icon name="arrowDown" />
        </IconButton>
        <IconButton title={t("Remove Layer")} disabled={readOnly || layers.length < 2 || !activeSlot} onClick={() => activeSlot && removeLayer(activeSlot)}>
          <Icon name="trash" />
        </IconButton>
      </div>
      <ul className="content-elements content-layers" role="listbox">
        {[...layers].reverse().map((slot) => {
          const value = resolved.textures[slot];
          return (
            <li key={slot} role="option" aria-selected={slot === activeSlot} className={slot === activeSlot ? "selected" : undefined} onClick={() => setPaintSlot(slot)}>
              <span className="content-layer-thumb">{value && shownImages[value] && <img src={shownImages[value]?.url} alt="" />}</span>
              <span className="content-element-name" title={value}>
                {slot}
                <span className="content-element-size"> {value ?? ""}</span>
              </span>
              <TintPicker view={view} index={layerIndex(slot)} />
            </li>
          );
        })}
      </ul>
      <p className="content-note">{t("Paint the layers here or right on the model. To shape the item in 3D, convert it to elements.")}</p>
      <div className="content-pane-actions">
        <Button variant="subtle" disabled={readOnly} onClick={() => void convertToElements()}>
          {t("Convert to 3D Elements")}
        </Button>
      </div>
    </>
  );
}

/** A layer's tint preview (its tint index): a color picker, cleared by right-click. */
function TintPicker({ view, index }: { view: ContentView; index: number }) {
  const { t, tints, setTints } = view.m;
  return (
    <label
      className="content-tint"
      title={t("Tint preview (tint index {n}) — right-click to clear", { n: index })}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        setTints(({ [index]: _, ...rest }) => rest);
      }}
    >
      <span style={{ background: tints[index] ?? "transparent" }} />
      <input type="color" value={tints[index] ?? "#ffffff"} onChange={(e) => setTints((m) => ({ ...m, [index]: e.target.value }))} />
    </label>
  );
}
