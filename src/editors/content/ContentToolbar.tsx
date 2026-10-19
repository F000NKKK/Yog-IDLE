import { belowButton, ContextMenu, type ContextMenuItem, Spacer, Toolbar, ToolbarButton, ToolbarCheck, ToolbarGroup, ToolbarModes, ToolbarSelect, withShortcut } from "substrate-platform-ui";
import { DISPLAY_SLOTS, type DisplaySlot, ITEM_MODEL_PRESETS, NEW_ITEM_TEXTURE } from "../../content/model";
import { defaultState } from "../../content/states";
import type { ViewName } from "../../content/Viewport";
import { kind as KIND } from "../../data/yogIds.generated";
import { ensureModel, MODEL, type ModelKey, STATE_PICK, stateModelKey, stateModelOf } from "./contentModel";
import type { ContentView } from "./contentView";

/** The longest the State button's label gets before it's cut. */
const STATE_LABEL_MAX = 48;
/** The paint mode, next to the gizmo's move/resize. */
const PAINT = "paint";

/** The content editor's toolbar: the model edited, the state shown, the tool, the view's options, and View Code. */
export function ContentToolbar({ view }: { view: ContentView }) {
  const { readOnly } = view.props;
  const { kind, stateProps, setPaintMode, gizmo, resolved } = view.m;
  const { pickGizmo, addSlot, viewCode } = view.cmd;
  const paintOn = view.pt.paintOn;
  return (
    <Toolbar>
      <ModelPicker view={view} />
      {stateProps.length > 0 && <StatePicker view={view} />}
      <ToolbarGroup>
        <ToolbarModes
          showLabels
          value={paintOn ? PAINT : gizmo}
          onChange={(mode) => (mode === PAINT ? setPaintMode(true) : pickGizmo(mode))}
          modes={[
            { value: "move", label: "Move", shortcut: "g", disabled: !!resolved.sprite },
            { value: "resize", label: "Resize", shortcut: "s", disabled: !!resolved.sprite },
            { value: PAINT, label: "Paint", shortcut: "p", disabled: readOnly },
          ]}
        />
      </ToolbarGroup>
      {kind === KIND.ITEM && <ItemPresets view={view} />}
      <ViewOptions view={view} />
      <DisplayOptions view={view} />
      <ToolbarGroup>
        <ToolbarButton icon="plus" label="Texture Slot…" showLabel disabled={readOnly} onClick={() => void addSlot()} />
      </ToolbarGroup>
      <Spacer />
      <ToolbarButton icon="code" label="View Code" shortcut="f7" onClick={viewCode} />
    </Toolbar>
  );
}

/** Which model is edited: the block's or item's, its item model, the connection arm, a state model. */
function ModelPicker({ view }: { view: ContentView }) {
  const { t, kind, file, effectiveKey, shownVariant, variantModelKey, setPreviewState, setStateSel, update, mainResolved, setModelKey, setSelected, setFace } = view.m;
  const choices: { value: ModelKey; label: string }[] = [{ value: MODEL.main, label: kind === KIND.BLOCK ? t("Block Model") : t("Item Model") }];
  if (kind === KIND.BLOCK) {
    choices.push({ value: MODEL.item, label: file.item_model ? t("Item Model") : t("Item Model (add)") });
    if (file.states?.connect) choices.push({ value: MODEL.arm, label: t("Connection Arm") });
    for (const n of view.cmd.stateModelNames) choices.push({ value: stateModelKey(n), label: t("State Model: {name}", { name: n }) });
  }
  const pick = (v: ModelKey) => {
    if (shownVariant && variantModelKey(shownVariant.models) !== v) setPreviewState(null);
    const state = stateModelOf(v);
    setStateSel(state !== null ? { kind: STATE_PICK.model, key: state } : null);
    if (v === MODEL.item && !file.item_model) update((d) => void (d.item_model = { parent: "generated", textures: { layer0: mainResolved.textures[mainResolved.slots[0]] ?? NEW_ITEM_TEXTURE } }));
    setModelKey(v);
    setSelected(null);
    setFace(null);
  };
  return (
    <ToolbarGroup>
      <ToolbarSelect value={effectiveKey} options={choices} onChange={(v) => pick(v as ModelKey)} />
    </ToolbarGroup>
  );
}

/** The block state the view shows: each property's value, and what that shows. */
function StatePicker({ view }: { view: ContentView }) {
  const { t, shownState, shownVariant, stateProps, stateMenu } = view.m;
  const { showState } = view.cmd;
  const shownModel = shownVariant ? (shownVariant.models.length ? shownVariant.models.join(" | ") : t("the block's model")) : "";
  const shows = shownVariant ? t("Shows {model}, turned x {x}° y {y}°", { model: shownModel, x: shownVariant.x, y: shownVariant.y }) : "";
  const label = shownState ? `${t("State")}: ${stateProps.map((p) => `${p.name}=${shownState[p.name]}`).join(", ")}` : t("No State");
  const items: ContextMenuItem[] = [
    { label: t("No State — the Model Unturned"), checked: !shownState, onSelect: () => showState(null) },
    { label: t("Default State"), onSelect: () => showState(defaultState(stateProps)) },
    ...stateProps.map((p, i) => ({
      label: shownState ? `${p.name} = ${shownState[p.name]}` : p.name,
      separatorBefore: i === 0,
      submenu: p.values.map((v) => ({ label: v, checked: shownState?.[p.name] === v, onSelect: () => showState({ ...(shownState ?? defaultState(stateProps)), [p.name]: v }) })),
    })),
    ...(shownVariant ? [{ label: shows, disabled: true, separatorBefore: true }] : []),
  ];
  return (
    <ToolbarGroup>
      <ToolbarButton
        icon="preview"
        label={label.length > STATE_LABEL_MAX ? `${label.slice(0, STATE_LABEL_MAX - 1)}…` : label}
        tooltip={shownVariant ? `${label}\n${shows}` : t("The block state the view shows: the model its variant picks, turned as the block stands")}
        showLabel
        dropdown
        onClick={(e) => stateMenu.openAtPoint(undefined, belowButton(e))}
      />
      <ContextMenu target={stateMenu.target} items={items} onClose={stateMenu.close} />
    </ToolbarGroup>
  );
}

/** An item's model presets (generated, handheld, ...): replace its model with one. */
function ItemPresets({ view }: { view: ContentView }) {
  const { t, setModelKey, setSelected, setFace, update } = view.m;
  const apply = (id: string) => {
    const preset = ITEM_MODEL_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setModelKey(MODEL.main);
    setSelected(null);
    setFace(null);
    update((d) => {
      d.model = { parent: preset.parent };
    });
  };
  return (
    <ToolbarGroup>
      <ToolbarSelect value="" options={[{ value: "", label: t("Model Preset…") }, ...ITEM_MODEL_PRESETS.map((preset) => ({ value: preset.id, label: t(preset.label) }))]} onChange={apply} />
    </ToolbarGroup>
  );
}

const VIEW_CHOICES: { value: ViewName; label: string; keys: string }[] = [
  { value: "front", label: "Front", keys: "1" },
  { value: "right", label: "Right", keys: "3" },
  { value: "top", label: "Top", keys: "7" },
  { value: "back", label: "Back", keys: "ctrl+1" },
  { value: "left", label: "Left", keys: "ctrl+3" },
  { value: "bottom", label: "Bottom", keys: "ctrl+7" },
];

/** Shading, the grid, and a view to jump to. */
function ViewOptions({ view }: { view: ContentView }) {
  const { t, shading, setShading, grid, setGrid, setViewRequest } = view.m;
  return (
    <ToolbarGroup>
      <ToolbarCheck label="Shading" checked={shading} onChange={setShading} />
      <ToolbarCheck label="Grid" checked={grid} onChange={setGrid} />
      <ToolbarSelect
        value=""
        options={[{ value: "", label: t("View…") }, ...VIEW_CHOICES.map((v) => ({ value: v.value, label: withShortcut(v.label, v.keys) }))]}
        onChange={(v) => v && setViewRequest({ view: v as ViewName, key: Date.now() })}
      />
    </ToolbarGroup>
  );
}

/** The display transform previewed (and its reset), and which of a block's rotations shows. */
function DisplayOptions({ view }: { view: ContentView }) {
  const { readOnly } = view.props;
  const { t, displaySlot, setDisplaySlot, model, update, effectiveKey, variant, setVariant } = view.m;
  const { rotations } = view.tx;
  return (
    <ToolbarGroup>
      <ToolbarSelect value={displaySlot} options={[{ value: "", label: t("No display transform") }, ...DISPLAY_SLOTS.map((s) => ({ value: s, label: s }))]} onChange={(v) => setDisplaySlot(v as DisplaySlot | "")} />
      {displaySlot && model?.display?.[displaySlot] && <ToolbarButton label="Reset" disabled={readOnly} onClick={() => update((d) => void delete ensureModel(d, effectiveKey).display?.[displaySlot])} />}
      {rotations.length > 1 && effectiveKey === MODEL.main && (
        <ToolbarSelect
          value={String(Math.min(variant, rotations.length - 1))}
          options={rotations.map((r, i) => ({ value: String(i), label: `${t("Variant")} ${i + 1} (x${r.x ?? 0} y${r.y ?? 0})` }))}
          onChange={(v) => setVariant(Number(v))}
        />
      )}
    </ToolbarGroup>
  );
}
