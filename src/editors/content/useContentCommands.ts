// Element and block-state commands, the keyboard and Edit menu, and the Properties rows.

import { useEffect, useMemo, useRef } from "react";
import { type EditorProps, notify, notifyDocumentCommands, promptDialog, type PropertyDescriptor, registerDocumentCommands, useKeybinding } from "substrate-platform-ui";
import type { GizmoMode } from "../../content/Viewport";
import { clone, type ContentFile, DIRS, type Element, serializeContent } from "../../content/model";
import { type BlockState, defaultState, freeName, isWord, moveVariant, newVariantKey, parseVariantKey, propertyNameProblem, removeModel, removeProperty, stateModelFrom, type States, variantOf, YES_NO } from "../../content/states";
import { readData } from "../../data/yogData";
import type { ContentModel } from "./useContentModel";
import type { ContentPaint } from "./useContentPaint";
import { ensureModel, MODEL, NEW_STATE_MODEL, STATE_PICK, stateModelKey, stateModelOf, type StateSel } from "./contentModel";
import { blockItemRows } from "./properties/blockItem";
import type { PropertiesContext } from "./properties/context";
import { generalRows } from "./properties/general";
import { modelRows } from "./properties/model";
import { propertyRows } from "./properties/rows";
import { stateRows } from "./properties/states";
import { CONTENT_SOURCE_VIEW } from "../ContentEditor";
import { kind as KIND } from "../../data/yogIds.generated";

/** Element and block-state commands, the keyboard and Edit menu, and the Properties rows. */
export function useContentCommands(props: EditorProps, m: ContentModel, pt: ContentPaint) {
  const { path, readOnly } = props;
  const { t, tabs, setView, kind, file, modelKey, setModelKey, setSelected, face, setFace, setGizmo, displaySlot, setPreviewState, setStateSel, choices, blockKinds, rootRef, blockRefs, entityRefs, effectRefs, paintMode, setPaintMode, paint, setPaint, effectiveKey, model, modelKind, resolved, mainResolved, elements, sel, selEl, states, stateProps, shownVariant, variantModelKey, pickedState, update, editElements } = m;
  const { shownImages } = pt;
  // ── Element commands ──────────────────────────────────────────────────────

  const firstSlot = resolved.slots[0];
  const addElement = () => {
    const slot = firstSlot ?? "0";
    editElements((els, m) => {
      if (!firstSlot) m.textures = { ...(m.textures ?? {}), [slot]: "minecraft:block/stone" };
      els.push({
        name: `cube${els.length + 1}`,
        from: [4, 0, 4],
        to: [12, 8, 12],
        faces: Object.fromEntries(DIRS.map((d) => [d, { texture: `#${slot}` }])),
      });
      setSelected(els.length - 1);
      setFace(null);
    });
  };
  const duplicateElement = () => {
    if (sel === null) return;
    editElements((els) => {
      els.splice(sel + 1, 0, { ...clone(els[sel]), name: els[sel].name ? `${els[sel].name}_copy` : undefined });
      setSelected(sel + 1);
    });
  };
  const deleteElement = () => {
    if (sel === null) return;
    editElements((els) => {
      els.splice(sel, 1);
      setSelected(els.length ? Math.min(sel, els.length - 1) : null);
      setFace(null);
    });
  };
  const moveElement = (by: -1 | 1) => {
    if (sel === null || sel + by < 0 || sel + by >= elements.length) return;
    editElements((els) => {
      const [el] = els.splice(sel, 1);
      els.splice(sel + by, 0, el);
      setSelected(sel + by);
    });
  };

  const addSlot = async () => {
    const slot = await promptDialog({
      title: t("Add Texture Slot"),
      label: t("Slot"),
      confirmLabel: t("Add"),
      validate: (v) => (/^[a-z0-9_]+$/.test(v) ? (resolved.slots.includes(v) ? t("This slot already exists.") : null) : t("Lowercase letters, digits and _.")),
    });
    if (slot) update((d) => void (ensureModel(d, effectiveKey).textures = { ...(ensureModel(d, effectiveKey).textures ?? {}), [slot]: "minecraft:block/stone" }));
  };

  // ── Block states ──────────────────────────────────────────────────────────

  /** Edits `states` (made if missing; emptied parts and an empty `states` removed). */
  const editStates = (edit: (st: States, d: ContentFile) => void) =>
    update((d) => {
      d.states ??= {};
      edit(d.states, d);
      for (const k of ["properties", "models", "variants"] as const) if (d.states[k] && !Object.keys(d.states[k]!).length) delete d.states[k];
      if (d.block && !Object.values(d.block).some((x) => x !== undefined)) delete d.block;
      if (!Object.values(d.states).some((x) => x !== undefined)) delete d.states;
    });

  /** Shows state `st` (`null`: the model as it is) and edits the model it shows. */
  const showState = (st: BlockState | null) => {
    setPreviewState(st);
    if (!st) return;
    const key = variantModelKey(variantOf(states, { ...defaultState(stateProps), ...st }).models);
    if (key !== effectiveKey) {
      setModelKey(key);
      setSelected(null);
      setFace(null);
    }
  };

  const pickState = (picked: StateSel) => {
    setStateSel(picked);
    setSelected(null);
    setFace(null);
    if (picked.kind === STATE_PICK.model) {
      setModelKey(stateModelKey(picked.key));
      if (shownVariant && variantModelKey(shownVariant.models) !== stateModelKey(picked.key)) setPreviewState(null);
    } else if (picked.kind === STATE_PICK.variant) {
      // The state it's for: its conditions over the default state.
      showState(Object.fromEntries(parseVariantKey(picked.key)));
    }
  };

  const stateModelNames = Object.keys(states?.models ?? {});

  const addStateProperty = async () => {
    const name = await promptDialog({
      title: t("Add State Property"),
      message: t("A property of the block's states, yes/no to start with — make it a number range or a list of values in Properties."),
      label: t("Name"),
      defaultValue: freeName("powered", stateProps.map((p) => p.name)),
      confirmLabel: t("Add"),
      validate: (v) => {
        const problem = propertyNameProblem(v, stateProps.map((p) => p.name));
        return problem && t(problem);
      },
    });
    if (!name) return;
    editStates((st) => void (st.properties = { ...(st.properties ?? {}), [name]: [...YES_NO] }));
    pickState({ kind: STATE_PICK.property, key: name });
  };

  /** A new state model, a copy of the block's model; edited in the view next. */
  const addStateModel = async () => {
    const name = await promptDialog({
      title: t("Add State Model"),
      message: t("Another model of the block, for the states its variants pick. It starts as a copy of the block's model."),
      label: t("Name"),
      defaultValue: freeName(NEW_STATE_MODEL, stateModelNames),
      confirmLabel: t("Add"),
      validate: (v) => (!isWord(v) ? t("Lowercase letters, digits and _.") : stateModelNames.includes(v) ? t("The block already has a model of this name.") : null),
    });
    if (!name) return;
    editStates((st) => void (st.models = { ...(st.models ?? {}), [name]: stateModelFrom(file.model) }));
    pickState({ kind: STATE_PICK.model, key: name });
  };

  /** A new variant for the first condition none has yet; a state model made for it if there's none. */
  const addVariant = () => {
    const key = newVariantKey(states ?? {});
    if (key === null) {
      notify({ level: "info", message: t("Every property's value already has a variant — edit their conditions in Properties.") });
      return;
    }
    const current = stateModelOf(effectiveKey);
    const name = current ?? stateModelNames[0] ?? NEW_STATE_MODEL;
    editStates((st) => {
      if (!st.models?.[name]) st.models = { ...(st.models ?? {}), [name]: stateModelFrom(file.model) };
      st.variants = { ...(st.variants ?? {}), [key]: name };
    });
    setStateSel({ kind: STATE_PICK.variant, key });
    setPreviewState(Object.fromEntries(parseVariantKey(key)));
    setModelKey(stateModelKey(name));
    setSelected(null);
    setFace(null);
  };

  const removeStateItem = (picked: StateSel) => {
    editStates((st, d) => {
      if (picked.kind === STATE_PICK.property) removeProperty(st, d.block, picked.key);
      else if (picked.kind === STATE_PICK.model) removeModel(st, picked.key);
      else if (st.variants) delete st.variants[picked.key];
    });
    if (picked.kind === STATE_PICK.model && effectiveKey === stateModelKey(picked.key)) setModelKey(MODEL.main);
    setStateSel(null);
  };

  const moveStateVariant = (key: string, by: -1 | 1) => editStates((st) => moveVariant(st, key, by));

  const viewCode = () => {
    const tab = tabs.find((x) => x.path === path);
    if (tab) void setView(tab.id, CONTENT_SOURCE_VIEW);
  };

  // ── Keyboard and Edit menu ────────────────────────────────────────────────

  const inField = () => {
    const el = document.activeElement;
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
  };
  const focusedWithin = () => !!rootRef.current && rootRef.current.contains(document.activeElement);
  const editable = () => !readOnly && focusedWithin() && !inField();
  /** Copies the selected element as JSON (pasteable into another model, or Blockbench-style text). */
  const copyElement = async () => {
    if (!selEl) return false;
    await navigator.clipboard.writeText(await serializeContent(selEl as unknown as ContentFile));
    return true;
  };
  const pasteElement = async () => {
    const read = await readData(await navigator.clipboard.readText().catch(() => ""));
    if (!read.ok) return;
    const value = read.value;
    const list = (Array.isArray(value) ? value : [value]).filter(
      (v): v is Element => !!v && typeof v === "object" && Array.isArray((v as Element).from) && Array.isArray((v as Element).to) && typeof (v as Element).faces === "object"
    );
    if (!list.length) return;
    editElements((els) => {
      const at = sel === null ? els.length : sel + 1;
      els.splice(at, 0, ...list);
      setSelected(at);
      setFace(null);
    });
  };
  /** Deletes the picked element, else the picked property, state model or variant. */
  const deleteSelected = () => (sel === null && pickedState ? removeStateItem(pickedState) : deleteElement());
  const commands = useRef({ deleteElement, deleteSelected, duplicateElement, copyElement, pasteElement, sel, elements });
  commands.current = { deleteElement, deleteSelected, duplicateElement, copyElement, pasteElement, sel, elements };
  useKeybinding("Delete", () => commands.current.deleteSelected(), { when: editable });
  useKeybinding("Ctrl+C", () => void commands.current.copyElement(), { when: editable });
  useKeybinding("Ctrl+X", () => void commands.current.copyElement().then((ok) => ok && commands.current.deleteElement()), { when: editable });
  useKeybinding("Ctrl+V", () => void commands.current.pasteElement(), { when: editable });
  useKeybinding("Ctrl+D", () => commands.current.duplicateElement(), { when: editable });
  const pickGizmo = (g: GizmoMode) => {
    setGizmo(g);
    setPaintMode(false);
  };
  useKeybinding("G", () => pickGizmo("move"), { when: editable });
  useKeybinding("S", () => pickGizmo("resize"), { when: editable });
  useKeybinding("P", () => setPaintMode(true), { when: editable });
  const painting = () => editable() && (paintMode || !!resolved.sprite);
  const paintRef = useRef(paint);
  paintRef.current = paint;
  useKeybinding("B", () => setPaint({ tool: "pencil" }), { when: painting });
  useKeybinding("E", () => setPaint({ tool: "eraser" }), { when: painting });
  useKeybinding("F", () => setPaint({ tool: "fill" }), { when: painting });
  useKeybinding("I", () => setPaint({ tool: "picker" }), { when: painting });
  useKeybinding("L", () => setPaint({ tool: "line" }), { when: painting });
  useKeybinding("R", () => setPaint({ tool: "rect" }), { when: painting });
  useKeybinding("M", () => setPaint({ mirrorX: !paintRef.current.mirrorX }), { when: painting });
  useKeybinding("[", () => setPaint({ size: Math.max(1, paintRef.current.size - 1) }), { when: painting });
  useKeybinding("]", () => setPaint({ size: Math.min(4, paintRef.current.size + 1) }), { when: painting });
  useKeybinding("F7", viewCode, { when: focusedWithin });

  useEffect(
    () =>
      registerDocumentCommands(path, {
        hasSelection: () => commands.current.sel !== null,
        cut: () => void commands.current.copyElement().then((ok) => ok && commands.current.deleteElement()),
        copy: () => void commands.current.copyElement(),
        canPaste: () => !readOnly,
        paste: () => void commands.current.pasteElement(),
        selectAll: () => {},
        delete: () => commands.current.deleteElement(),
      }),
    [path, readOnly]
  );
  useEffect(() => notifyDocumentCommands(), [sel]);

  // ── Properties ────────────────────────────────────────────────────────────

  const properties = useMemo<PropertyDescriptor[]>(() => {
    const out: PropertyDescriptor[] = [];
    const ctx: PropertiesContext = {
      ...propertyRows(file, readOnly),
      file, kind, update, choices, blockKinds, blockRefs, effectRefs, entityRefs, readOnly,
      editStates, effectiveKey, modelKey, mainResolved, resolved, pickedState, setModelKey, setPreviewState, setStateSel,
      stateModelNames, stateProps, states, displaySlot, editElements, face, model, modelKind, sel, selEl, shownImages,
    };
    generalRows(ctx, out);
    blockItemRows(ctx, out);
    stateRows(ctx, out);
    modelRows(ctx, out);

    // A picked property, state model or variant is the object shown: its rows (a model's with its model's).
    if (kind === KIND.BLOCK && pickedState && states) {
      const file = new Set([t("General"), t("Block"), t("Item"), t("States")]);
      return out.filter((r) => !file.has(r.category ?? "") && (pickedState.kind === STATE_PICK.model || /^s[pmv]\./.test(r.id)));
    }
    return out;
    // `t` and the helpers read fresh state each render.
  }, [file, kind, model, resolved, mainResolved, shownImages, choices, blockKinds, blockRefs, entityRefs, effectRefs, displaySlot, selEl, sel, face, readOnly, effectiveKey, modelKind, modelKey, pickedState, stateProps]);

  return { firstSlot, addElement, duplicateElement, deleteElement, moveElement, addSlot, editStates, showState, pickState, stateModelNames, addStateProperty, addStateModel, addVariant, removeStateItem, moveStateVariant, viewCode, inField, focusedWithin, editable, copyElement, pasteElement, deleteSelected, commands, pickGizmo, painting, paintRef, properties };
}

/** What `useContentCommands` gives the editor. */
export type ContentCommands = ReturnType<typeof useContentCommands>;
