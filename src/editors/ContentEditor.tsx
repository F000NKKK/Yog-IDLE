import { cropFrame, stillAnimation } from "../content/animation";
import { FrameStrip } from "../content/paint/FrameStrip";
import {
  belowButton,
  Button,
  ContextMenu,
  type ContextMenuItem,
  type EditorProps,
  Icon,
  IconButton,
  type PropertyDescriptor,
  SelectField,
  Spacer,
  Toolbar,
  ToolbarButton,
  ToolbarCheck,
  ToolbarGroup,
  ToolbarModes,
  ToolbarSelect,
  usePropertyContext,
  withShortcut,
} from "substrate-platform-ui";
import {
  autoUv,
  DIRS,
  DISPLAY_SLOTS,
  ITEM_MODEL_PRESETS,
  type DisplaySlot,
} from "../content/model";
import {
  defaultState,
  modelNames,
  propertyKind,
  statesShowing,
  variantProblems,
} from "../content/states";
import { UvEditor } from "../content/UvEditor";
import { Viewport, type ViewName } from "../content/Viewport";
import { PaintCanvas } from "../content/paint/PaintCanvas";
import { PaintTools } from "../content/paint/PaintTools";
import "./ContentEditor.css";
import { fmt } from "./content/fieldText";
import { ensureModel, layerIndex, type ModelKey, STATE_SEL_TYPES, stateModelKey, stateModelOf, type StateSel } from "./content/contentModel";
import { useContentModel } from "./content/useContentModel";
import { useContentTextures } from "./content/useContentTextures";
import { useContentPaint } from "./content/useContentPaint";
import { useContentCommands } from "./content/useContentCommands";

export const CONTENT_SOURCE_VIEW = "yog.content.source";

/**
 * The `.yblock` / `.yitem` editor: the block's or item's 3D model in a
 * Blender-like view (Viewport), an outliner of its elements, its properties
 * (the block/item metadata, the model, the selected element and face, display
 * transforms, block states) in a Properties grid, and a UV editor for the
 * selected face. A block's states — its own properties, its state models and
 * the variants picking them — are listed under the elements; the toolbar's
 * State picks the state the view shows (its model, turned as it stands).
 * Every edit patches the file's text through `onChange` (what didn't change,
 * comments too, stays as written) — dirty state, Save and external reload as
 * for any file; undo/redo steps over the file's text; F7 opens the JSON.
 */
export function ContentEditor(props: EditorProps) {
  const { path, onChange, readOnly } = props;
  const m = useContentModel(props);
  const tx = useContentTextures(props, m);
  const pt = useContentPaint(props, m, tx);
  const cmd = useContentCommands(props, m, pt);
  const { t, kind, parsed, file, setModelKey, selected, setSelected, face, setFace, gizmo, shading, setShading, grid, setGrid, displaySlot, setDisplaySlot, variant, setVariant, setPreviewState, setStateSel, stateMenu, viewRequest, setViewRequest, images, rootRef, setPaintMode, paint, setPaint, setPaintSlot, tints, setTints, setPaintEntry, playing, setPlaying, effectiveKey, model, resolved, mainResolved, elements, sel, selEl, states, stateProps, shownState, shownVariant, variantModelKey, pickedState, update, editElements } = m;
  const { pixelsOf, rotations, parts, display, onSelect, onTransform } = tx;
  const { paintOn, paintSlots, activeSlot, activeKey, activeAnim, activeEntry, activeFrame, shownImages, editAnimation, onCanvasPaint, onViewportPaint, newTexture, layers, addLayer, removeLayer, moveLayer, convertToElements } = pt;
  const { addElement, duplicateElement, deleteElement, moveElement, addSlot, showState, pickState, stateModelNames, addStateProperty, addStateModel, addVariant, removeStateItem, moveStateVariant, viewCode, pickGizmo, properties } = cmd;

  // ── Layout ────────────────────────────────────────────────────────────────

  // Shown once every hook below has run (their number mustn't change between renders).
  const broken =
    parsed && !parsed.ok ? (
      <div className="content-editor content-broken">
        <p>{t("This file isn't valid JSON: {error}", { error: parsed.error })}</p>
        <Button onClick={viewCode}>{t("View Code")}</Button>
      </div>
    ) : null;

  const modelChoices: { value: ModelKey; label: string }[] = [{ value: "model", label: kind === "block" ? t("Block Model") : t("Item Model") }];
  if (kind === "block") {
    modelChoices.push({ value: "item_model", label: file.item_model ? t("Item Model") : t("Item Model (add)") });
    if (file.states?.connect) modelChoices.push({ value: "arm", label: t("Connection Arm") });
  }
  for (const n of kind === "block" ? stateModelNames : []) modelChoices.push({ value: stateModelKey(n), label: t("State Model: {name}", { name: n }) });
  const pickModel = (v: ModelKey) => {
    if (shownVariant && variantModelKey(shownVariant.models) !== v) setPreviewState(null);
    const state = stateModelOf(v);
    setStateSel(state !== null ? { kind: "model", key: state } : null);
    if (v === "item_model" && !file.item_model) update((d) => void (d.item_model = { parent: "generated", textures: { layer0: mainResolved.textures[mainResolved.slots[0]] ?? "minecraft:item/apple" } }));
    setModelKey(v);
    setSelected(null);
    setFace(null);
  };
  const applyItemPreset = (id: string) => {
    const preset = ITEM_MODEL_PRESETS.find((p) => p.id === id);
    if (!preset || kind !== "item") return;
    setModelKey("model");
    setSelected(null);
    setFace(null);
    update((d) => {
      d.model = { parent: preset.parent };
    });
  };

  const faceData = selEl && face ? selEl.faces[face] : undefined;
  const faceTexture = faceData ? resolved.textures[faceData.texture.replace(/^#/, "")] : undefined;
  const otherUvs =
    selEl && face && faceData
      ? DIRS.filter((d) => d !== face && selEl.faces[d]?.texture === faceData.texture).map((d) => selEl.faces[d]!.uv ?? autoUv(d, selEl.from, selEl.to))
      : [];

  // The 2D paint view: the active slot's texture, the selected element's faces on it outlined.
  const activeImg = pixelsOf(activeKey);
  const overlays: { rect: [number, number, number, number]; primary?: boolean }[] = [];
  if (paintOn && activeImg && activeSlot && selEl && !resolved.sprite) {
    const sx = (activeAnim?.frameWidth ?? activeImg.w) / 16;
    const sy = (activeAnim?.frameHeight ?? activeImg.h) / 16;
    for (const d of DIRS) {
      const f = selEl.faces[d];
      if (!f || f.texture.replace(/^#/, "") !== activeSlot) continue;
      const [u0, v0, u1, v1] = f.uv ?? autoUv(d, selEl.from, selEl.to);
      overlays.push({ rect: [u0 * sx, v0 * sy, u1 * sx, v1 * sy], primary: d === face });
    }
  }
  const activeForeign = !!activeKey && !!images[activeKey] && !images[activeKey]!.writable;
  const spriteNote = resolved.sprite
    ? t("Paint the layers here or right on the model. To shape the item in 3D, convert it to elements.")
    : null;

  const paintPanel = paintOn && (
    <>
      <div className="content-pane-header">
        <span>{t("Paint")}</span>
        <Spacer />
        <Button variant="ghost" onClick={() => void newTexture()} title={t("A blank texture for the slot being painted")}>
          {t("New Texture…")}
        </Button>
      </div>
      <PaintTools paint={paint} onChange={setPaint} disabled={readOnly} />
    </>
  );

  const layersPanel = resolved.sprite && (
    <>
      <div className="content-pane-header">
        <span>{t("Layers")}</span>
        <Spacer />
        <IconButton title={t("Add Layer")} disabled={readOnly} onClick={addLayer}>
          <Icon name="plus" />
        </IconButton>
        <IconButton title={t("Move Up")} disabled={readOnly || !activeSlot || layerIndex(activeSlot) <= 0} onClick={() => activeSlot && moveLayer(activeSlot, -1)}>
          <Icon name="arrowUp" />
        </IconButton>
        <IconButton
          title={t("Move Down")}
          disabled={readOnly || !activeSlot || layerIndex(activeSlot) < 0 || layerIndex(activeSlot) >= layers.length - 1}
          onClick={() => activeSlot && moveLayer(activeSlot, 1)}
        >
          <Icon name="arrowDown" />
        </IconButton>
        <IconButton title={t("Remove Layer")} disabled={readOnly || layers.length < 2 || !activeSlot} onClick={() => activeSlot && removeLayer(activeSlot)}>
          <Icon name="trash" />
        </IconButton>
      </div>
      <ul className="content-elements content-layers" role="listbox">
        {[...layers].reverse().map((slot) => {
          const value = resolved.textures[slot];
          const index = layerIndex(slot);
          return (
            <li key={slot} role="option" aria-selected={slot === activeSlot} className={slot === activeSlot ? "selected" : undefined} onClick={() => setPaintSlot(slot)}>
              <span className="content-layer-thumb">{value && shownImages[value] && <img src={shownImages[value]!.url} alt="" />}</span>
              <span className="content-element-name" title={value}>
                {slot}
                <span className="content-element-size"> {value ?? ""}</span>
              </span>
              <label className="content-tint" title={t("Tint preview (tint index {n}) — right-click to clear", { n: index })} onClick={(e) => e.stopPropagation()}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTints(({ [index]: _, ...rest }) => rest);
                }}
              >
                <span style={{ background: tints[index] ?? "transparent" }} />
                <input type="color" value={tints[index] ?? "#ffffff"} onChange={(e) => setTints((m) => ({ ...m, [index]: e.target.value }))} />
              </label>
            </li>
          );
        })}
      </ul>
      <p className="content-note">{spriteNote}</p>
      <div className="content-pane-actions">
        <Button variant="subtle" disabled={readOnly} onClick={() => void convertToElements()}>
          {t("Convert to 3D Elements")}
        </Button>
      </div>
    </>
  );

  const elementsPanel = !resolved.sprite && (
    <>
      <div className="content-pane-header">
        <span>{t("Elements")}</span>
        <Spacer />
        <IconButton title={t("Add Element")} disabled={readOnly} onClick={addElement}>
          <Icon name="plus" />
        </IconButton>
        <IconButton title={withShortcut("Duplicate", "ctrl+d")} disabled={readOnly || sel === null} onClick={duplicateElement}>
          <Icon name="split" />
        </IconButton>
        <IconButton title={t("Move Up")} disabled={readOnly || sel === null || sel === 0} onClick={() => moveElement(-1)}>
          <Icon name="arrowUp" />
        </IconButton>
        <IconButton title={t("Move Down")} disabled={readOnly || sel === null || sel === elements.length - 1} onClick={() => moveElement(1)}>
          <Icon name="arrowDown" />
        </IconButton>
        <IconButton title={`${t("Delete")} (Del)`} disabled={readOnly || sel === null} onClick={deleteElement}>
          <Icon name="trash" />
        </IconButton>
      </div>
      {!resolved.own && elements.length > 0 && (
        <p className="content-note">{t("These elements come from {parent}. Editing one copies them into this model.", { parent: model?.parent ?? "" })}</p>
      )}
      <ul className="content-elements" role="listbox">
        {elements.map((el, i) => (
          <li key={i} role="option" aria-selected={i === sel} className={i === sel ? "selected" : undefined} onClick={() => onSelect(i, null)}>
            <Icon name={i === sel ? "check" : "grid"} size={13} />
            <span className="content-element-name">{el.name ?? `${t("Element")} ${i + 1}`}</span>
            <span className="content-element-size">
              {el.to.map((x, k) => fmt(x - el.from[k])).join("×")}
              {el.rotation?.angle ? ` ↻${el.rotation.angle}°${el.rotation.axis}` : ""}
            </span>
          </li>
        ))}
      </ul>
      {selEl && (
        <div className="content-faces">
          {DIRS.map((d) => (
            <button key={d} type="button" className={`content-face${face === d ? " selected" : ""}${selEl.faces[d] ? "" : " off"}`} onClick={() => onSelect(sel, d)}>
              {t(d)}
            </button>
          ))}
        </div>
      )}
    </>
  );

  // The block's states: its properties, its other models, which state shows which.
  const builtInOption: Record<string, string> = { facing: t("Facing"), face: t("Attaches"), waterlogged: t("Waterloggable") };
  const isPicked = (what: StateSel["kind"], key: string) => pickedState?.kind === what && pickedState.key === key;
  const pickedVariant = pickedState?.kind === "variant" ? pickedState.key : null;
  const variantKeys = Object.keys(states?.variants ?? {});
  const statesPanel = kind === "block" && (
    <>
      <div className="content-pane-header">
        <span>{t("State Properties")}</span>
        <Spacer />
        <IconButton title={t("Add State Property")} disabled={readOnly} onClick={() => void addStateProperty()}>
          <Icon name="plus" />
        </IconButton>
        <IconButton title={t("Remove State Property")} disabled={readOnly || pickedState?.kind !== "property"} onClick={() => pickedState && removeStateItem(pickedState)}>
          <Icon name="trash" />
        </IconButton>
      </div>
      <ul className="content-elements" role="listbox" aria-label={t("State Properties")}>
        {stateProps.map((p) => {
          const pk = propertyKind(p.values);
          const summary = pk === "bool" ? t("yes/no") : pk === "range" ? `${Math.min(...p.values.map(Number))}–${Math.max(...p.values.map(Number))}` : p.values.join(", ");
          return p.own ? (
            <li key={p.name} role="option" aria-selected={isPicked("property", p.name)} className={isPicked("property", p.name) ? "selected" : undefined} title={p.values.join(", ")} onClick={() => pickState({ kind: "property", key: p.name })}>
              <Icon name="list" size={13} />
              <span className="content-element-name">{p.name}</span>
              <span className="content-element-size content-state-values">{summary}</span>
            </li>
          ) : (
            <li key={p.name} className="content-state-builtin" title={t("Made by {option} — set it in Properties.", { option: builtInOption[p.name] })}>
              <Icon name="settings" size={13} />
              <span className="content-element-name">{p.name}</span>
              <span className="content-element-size content-state-values">{summary}</span>
            </li>
          );
        })}
      </ul>
      {!stateProps.length && <p className="content-note">{t("One state only. Set Facing, Attaches or Waterloggable in Properties, or add a property of the block's own.")}</p>}
      <div className="content-pane-header">
        <span>{t("State Models")}</span>
        <Spacer />
        <IconButton title={t("Add State Model")} disabled={readOnly} onClick={() => void addStateModel()}>
          <Icon name="plus" />
        </IconButton>
        <IconButton title={t("Remove State Model")} disabled={readOnly || pickedState?.kind !== "model"} onClick={() => pickedState && removeStateItem(pickedState)}>
          <Icon name="trash" />
        </IconButton>
      </div>
      <ul className="content-elements" role="listbox" aria-label={t("State Models")}>
        {stateModelNames.map((n) => (
          <li key={n} role="option" aria-selected={isPicked("model", n)} className={isPicked("model", n) ? "selected" : undefined} onClick={() => pickState({ kind: "model", key: n })}>
            <Icon name={effectiveKey === stateModelKey(n) ? "check" : "grid"} size={13} />
            <span className="content-element-name">{n}</span>
          </li>
        ))}
      </ul>
      <div className="content-pane-header">
        <span>{t("Variants")}</span>
        <Spacer />
        <IconButton title={t("Add Variant")} disabled={readOnly || !stateProps.length} onClick={addVariant}>
          <Icon name="plus" />
        </IconButton>
        <IconButton title={t("Move Up")} disabled={readOnly || !pickedVariant || variantKeys.indexOf(pickedVariant) <= 0} onClick={() => pickedVariant !== null && moveStateVariant(pickedVariant, -1)}>
          <Icon name="arrowUp" />
        </IconButton>
        <IconButton
          title={t("Move Down")}
          disabled={readOnly || pickedVariant === null || variantKeys.indexOf(pickedVariant) >= variantKeys.length - 1}
          onClick={() => pickedVariant !== null && moveStateVariant(pickedVariant, 1)}
        >
          <Icon name="arrowDown" />
        </IconButton>
        <IconButton title={t("Remove Variant")} disabled={readOnly || pickedVariant === null} onClick={() => pickedState && removeStateItem(pickedState)}>
          <Icon name="trash" />
        </IconButton>
      </div>
      <ul className="content-elements" role="listbox" aria-label={t("Variants")}>
        {variantKeys.map((k) => {
          const problems = variantProblems(states!, k).map((x) => t(x.message, x.params));
          if (!problems.length && !statesShowing(states!, k)) problems.push(t("Never shown: a variant above it matches every state it would."));
          return (
            <li
              key={k}
              role="option"
              aria-selected={isPicked("variant", k)}
              className={isPicked("variant", k) ? "selected" : undefined}
              title={problems.length ? problems.join("\n") : undefined}
              onClick={() => pickState({ kind: "variant", key: k })}
            >
              <Icon name={problems.length ? "warning" : shownVariant?.key === k ? "preview" : "split"} size={13} />
              <span className="content-element-name">{k || t("Every state")}</span>
              <span className="content-element-size content-state-values">{modelNames(states!.variants![k]).join(", ")}</span>
            </li>
          );
        })}
      </ul>
      {stateProps.length > 0 && !variantKeys.length && <p className="content-note">{t("Every state shows the block's model. Add a variant to show another model in some states.")}</p>}
    </>
  );

  // The state the view shows: each property's value, and what that shows.
  const shownModel = shownVariant ? (shownVariant.models.length ? shownVariant.models.join(" | ") : t("the block's model")) : "";
  const stateLabel = shownState ? `${t("State")}: ${stateProps.map((p) => `${p.name}=${shownState[p.name]}`).join(", ")}` : t("No State");
  const stateMenuItems: ContextMenuItem[] = [
    { label: t("No State — the Model Unturned"), checked: !shownState, onSelect: () => showState(null) },
    { label: t("Default State"), onSelect: () => showState(defaultState(stateProps)) },
    ...stateProps.map((p, i) => ({
      label: shownState ? `${p.name} = ${shownState[p.name]}` : p.name,
      separatorBefore: i === 0,
      submenu: p.values.map((v) => ({
        label: v,
        checked: shownState?.[p.name] === v,
        onSelect: () => showState({ ...(shownState ?? defaultState(stateProps)), [p.name]: v }),
      })),
    })),
    ...(shownVariant
      ? [{ label: t("Shows {model}, turned x {x}° y {y}°", { model: shownModel, x: shownVariant.x, y: shownVariant.y }), disabled: true, separatorBefore: true }]
      : []),
  ];

  // What Properties shows while this editor is active: the selected
  // element (or the file's own fields), the face's UV under them.
  const uvRow: PropertyDescriptor | null =
    !paintOn && faceData && face && selEl
      ? {
          id: "uv",
          category: t("UV"),
          name: t("UV"),
          value: null,
          render: () => (
            <div className="content-uv-pane">
                <div className="content-pane-header">
                  <span>
                    {t("UV")}: {t(face)}
                  </span>
                  <Spacer />
                  <Button variant="ghost" disabled={readOnly || !faceData.uv} onClick={() => editElements((els) => void delete els[sel!].faces[face]!.uv)}>
                    {t("Auto UV")}
                  </Button>
                </div>
                <UvEditor
                  image={faceTexture ? shownImages[faceTexture] : undefined}
                  uv={faceData.uv ?? autoUv(face, selEl.from, selEl.to)}
                  others={otherUvs}
                  readOnly={readOnly}
                  onCommit={(uv) => editElements((els) => void (els[sel!].faces[face]!.uv = uv))}
                />
              </div>
          ),
        }
      : null;
  usePropertyContext(path, {
    // A picked property's or variant's rows as declared: name, kind, values; conditions, models.
    order: pickedState && !selEl ? "declared" : "sorted",
    objectName: selEl
      ? (selEl.name ?? `${t("Element")} ${(sel ?? 0) + 1}`)
      : pickedState
        ? pickedState.key || t("Every state")
        : (file.name ?? path.split(/[\\/]/).pop()),
    objectType: selEl ? t("Element") : pickedState ? t(STATE_SEL_TYPES[pickedState.kind]) : kind === "block" ? t("Block") : t("Item"),
    objectKey: `${effectiveKey}:${sel ?? "-"}:${face ?? "-"}:${pickedState ? `${pickedState.kind}:${pickedState.key}` : "-"}`,
    properties: uvRow ? [...properties, uvRow] : properties,
  });

  if (!parsed) return null;
  if (broken) return broken;
  return (
    <div className="content-editor" ref={rootRef}>
      <Toolbar>
        <ToolbarGroup>
          <ToolbarSelect value={effectiveKey} options={modelChoices} onChange={(v) => pickModel(v as ModelKey)} />
        </ToolbarGroup>
        {stateProps.length > 0 && (
          <ToolbarGroup>
            <ToolbarButton
              icon="preview"
              label={stateLabel.length > 48 ? `${stateLabel.slice(0, 47)}…` : stateLabel}
              tooltip={shownVariant ? `${stateLabel}\n${t("Shows {model}, turned x {x}° y {y}°", { model: shownModel, x: shownVariant.x, y: shownVariant.y })}` : t("The block state the view shows: the model its variant picks, turned as the block stands")}
              showLabel
              dropdown
              onClick={(e) => stateMenu.openAtPoint(undefined, belowButton(e))}
            />
            <ContextMenu target={stateMenu.target} items={stateMenuItems} onClose={stateMenu.close} />
          </ToolbarGroup>
        )}
        <ToolbarGroup>
          <ToolbarModes
            showLabels
            value={paintOn ? "paint" : gizmo}
            onChange={(m) => (m === "paint" ? setPaintMode(true) : pickGizmo(m))}
            modes={[
              { value: "move", label: "Move", shortcut: "g", disabled: !!resolved.sprite },
              { value: "resize", label: "Resize", shortcut: "s", disabled: !!resolved.sprite },
              { value: "paint", label: "Paint", shortcut: "p", disabled: readOnly },
            ]}
          />
        </ToolbarGroup>
        {kind === "item" && (
          <ToolbarGroup>
            <ToolbarSelect
              value=""
              options={[
                { value: "", label: t("Model Preset…") },
                ...ITEM_MODEL_PRESETS.map((preset) => ({ value: preset.id, label: t(preset.label) })),
              ]}
              onChange={applyItemPreset}
            />
          </ToolbarGroup>
        )}
        <ToolbarGroup>
          <ToolbarCheck label="Shading" checked={shading} onChange={setShading} />
          <ToolbarCheck label="Grid" checked={grid} onChange={setGrid} />
          <ToolbarSelect
            value=""
            options={[
              { value: "", label: t("View…") },
              { value: "front", label: withShortcut("Front", "1") },
              { value: "right", label: withShortcut("Right", "3") },
              { value: "top", label: withShortcut("Top", "7") },
              { value: "back", label: withShortcut("Back", "ctrl+1") },
              { value: "left", label: withShortcut("Left", "ctrl+3") },
              { value: "bottom", label: withShortcut("Bottom", "ctrl+7") },
            ]}
            onChange={(v) => v && setViewRequest({ view: v as ViewName, key: Date.now() })}
          />
        </ToolbarGroup>
        <ToolbarGroup>
          <ToolbarSelect
            value={displaySlot}
            options={[{ value: "", label: t("No display transform") }, ...DISPLAY_SLOTS.map((s) => ({ value: s, label: s }))]}
            onChange={(v) => setDisplaySlot(v as DisplaySlot | "")}
          />
          {displaySlot && model?.display?.[displaySlot] && (
            <ToolbarButton label="Reset" disabled={readOnly} onClick={() => update((d) => void delete ensureModel(d, effectiveKey).display?.[displaySlot])} />
          )}
          {rotations.length > 1 && effectiveKey === "model" && (
            <ToolbarSelect
              value={String(Math.min(variant, rotations.length - 1))}
              options={rotations.map((r, i) => ({ value: String(i), label: `${t("Variant")} ${i + 1} (x${r.x ?? 0} y${r.y ?? 0})` }))}
              onChange={(v) => setVariant(Number(v))}
            />
          )}
        </ToolbarGroup>
        <ToolbarGroup>
          <ToolbarButton icon="plus" label="Texture Slot…" showLabel disabled={readOnly} onClick={() => void addSlot()} />
        </ToolbarGroup>
        <Spacer />
        <ToolbarButton icon="code" label="View Code" shortcut="f7" onClick={viewCode} />
      </Toolbar>
      <div className="content-body">
        <div className="content-outliner">
          {paintPanel}
          {layersPanel}
          {elementsPanel}
          {statesPanel}
        </div>
        <div className="content-center">
          {paintOn && (
            <div className="content-paint">
              <div className="content-pane-header">
                <SelectField
                  aria-label={t("Texture")}
                  value={activeSlot ?? ""}
                  options={paintSlots.map((s) => ({ value: s, label: `${s}: ${resolved.textures[s]}` }))}
                  onChange={(v) => setPaintSlot(v)}
                />
                {activeForeign && <span className="content-paint-note">{t("Not the mod's texture — the first stroke copies it into the mod.")}</span>}
                <Spacer />
                {activeKey && activeImg && !activeAnim && !activeForeign && (
                  <ToolbarButton icon="play" label="Animate" showLabel tooltip="Make it an animated texture: frames, played in game (.png.mcmeta)" disabled={readOnly} onClick={() => editAnimation(activeKey, stillAnimation(activeImg))} />
                )}
              </div>
              <PaintCanvas
                className="content-paint-canvas"
                image={activeImg ? (activeAnim ? cropFrame(activeImg, activeAnim, activeFrame) : activeImg) : null}
                overlays={overlays}
                grid={paint.grid}
                brushSize={paint.tool === "pencil" || paint.tool === "eraser" || paint.tool === "line" ? paint.size : 1}
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
          )}
          <Viewport
            className="content-viewport"
            parts={parts}
            images={shownImages}
            selected={sel}
            selectedFace={face}
            onSelect={onSelect}
            onTransform={readOnly || paintOn ? undefined : onTransform}
            onPaint={paintOn ? onViewportPaint : null}
            gizmo={gizmo}
            shading={shading}
            showGrid={grid}
            renderLayer={file.block?.render_layer}
            display={display}
            viewRequest={viewRequest}
          />
        </div>
      </div>
    </div>
  );
}
