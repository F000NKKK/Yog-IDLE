// A block's states: picking what's shown or edited, and adding, removing and
// reordering properties, state models and variants.

import { notify, promptDialog } from "substrate-platform-ui";
import type { ContentFile } from "../../content/model";
import { type BlockState, defaultState, freeName, isWord, moveVariant, newVariantKey, parseVariantKey, propertyNameProblem, removeModel, removeProperty, stateModelFrom, type States, variantOf, YES_NO } from "../../content/states";
import { MODEL, NEW_STATE_MODEL, STATE_PICK, stateModelKey, stateModelOf, type StateSel } from "./contentModel";
import type { ContentModel } from "./useContentModel";

/** What a new property is called, unless that's taken. */
const NEW_PROPERTY = "powered";
const STATE_PARTS = ["properties", "models", "variants"] as const;

/** Picking a state to show, or a property, state model or variant to edit — and editing `states`. */
export function statePicking(m: ContentModel) {
  const { states, stateProps, effectiveKey, shownVariant, variantModelKey, update, setPreviewState, setStateSel, setModelKey, setSelected, setFace } = m;

  /** Edits `states` (made if missing; emptied parts and an empty `states` removed). */
  const editStates = (edit: (st: States, d: ContentFile) => void) =>
    update((d) => {
      d.states ??= {};
      edit(d.states, d);
      for (const k of STATE_PARTS) if (d.states[k] && !Object.keys(d.states[k] ?? {}).length) delete d.states[k];
      if (d.block && !Object.values(d.block).some((x) => x !== undefined)) delete d.block;
      if (!Object.values(d.states).some((x) => x !== undefined)) delete d.states;
    });

  /** Shows state `st` (`null`: the model as it is) and edits the model it shows. */
  const showState = (st: BlockState | null) => {
    setPreviewState(st);
    if (!st) return;
    const key = variantModelKey(variantOf(states, { ...defaultState(stateProps), ...st }).models);
    if (key === effectiveKey) return;
    setModelKey(key);
    setSelected(null);
    setFace(null);
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

  return { editStates, showState, pickState, stateModelNames: Object.keys(states?.models ?? {}) };
}

export type StatePicking = ReturnType<typeof statePicking>;

/** Adding, removing and reordering a block's state properties, state models and variants. */
export function stateEdits(m: ContentModel, { editStates, pickState, stateModelNames }: StatePicking) {
  const { t, file, states, stateProps, effectiveKey, setStateSel, setPreviewState, setModelKey, setSelected, setFace } = m;

  const addStateProperty = async () => {
    const names = stateProps.map((p) => p.name);
    const name = await promptDialog({
      title: t("Add State Property"),
      message: t("A property of the block's states, yes/no to start with — make it a number range or a list of values in Properties."),
      label: t("Name"),
      defaultValue: freeName(NEW_PROPERTY, names),
      confirmLabel: t("Add"),
      validate: (v) => {
        const problem = propertyNameProblem(v, names);
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
    const name = stateModelOf(effectiveKey) ?? stateModelNames[0] ?? NEW_STATE_MODEL;
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

  return { addStateProperty, addStateModel, addVariant, removeStateItem, moveStateVariant };
}
