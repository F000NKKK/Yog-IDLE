import type { ReactNode } from "react";
import { Icon, IconButton, Spacer } from "substrate-platform-ui";
import { modelNames, propertyKind, STATE_PROPERTY_KIND, statesShowing, variantProblems } from "../../../content/states";
import { STATE_PICK, stateModelKey, type StateSel } from "../contentModel";
import type { ContentView } from "../contentView";

/** The properties a block option makes, and the option's name. */
const BUILT_IN_OPTION: Record<string, string> = { facing: "Facing", face: "Attaches", waterlogged: "Waterloggable" };

/** A block's states: its properties, its other models, and which state shows which (variants). */
export function StatesPanel({ view }: { view: ContentView }) {
  return (
    <>
      <StatePropertiesList view={view} />
      <StateModelsList view={view} />
      <VariantsList view={view} />
    </>
  );
}

/** Whether `what` `key` is what's picked in the states lists. */
function picked(view: ContentView, what: StateSel["kind"], key: string): boolean {
  const p = view.m.pickedState;
  return p?.kind === what && p.key === key;
}

/** A states list's header: its title and add/remove (and more) buttons. */
function ListHeader({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="content-pane-header">
      <span>{title}</span>
      <Spacer />
      {children}
    </div>
  );
}

function StatePropertiesList({ view }: { view: ContentView }) {
  const { readOnly } = view.props;
  const { t, stateProps, pickedState } = view.m;
  const { addStateProperty, removeStateItem, pickState } = view.cmd;
  return (
    <>
      <ListHeader title={t("State Properties")}>
        <IconButton title={t("Add State Property")} disabled={readOnly} onClick={() => void addStateProperty()}>
          <Icon name="plus" />
        </IconButton>
        <IconButton title={t("Remove State Property")} disabled={readOnly || pickedState?.kind !== STATE_PICK.property} onClick={() => pickedState && removeStateItem(pickedState)}>
          <Icon name="trash" />
        </IconButton>
      </ListHeader>
      <ul className="content-elements" role="listbox" aria-label={t("State Properties")}>
        {stateProps.map((p) => {
          const pk = propertyKind(p.values);
          const summary = pk === STATE_PROPERTY_KIND.bool ? t("yes/no") : pk === STATE_PROPERTY_KIND.range ? `${Math.min(...p.values.map(Number))}–${Math.max(...p.values.map(Number))}` : p.values.join(", ");
          const isPicked = picked(view, STATE_PICK.property, p.name);
          return p.own ? (
            <li key={p.name} role="option" aria-selected={isPicked} className={isPicked ? "selected" : undefined} title={p.values.join(", ")} onClick={() => pickState({ kind: STATE_PICK.property, key: p.name })}>
              <Icon name="list" size={13} />
              <span className="content-element-name">{p.name}</span>
              <span className="content-element-size content-state-values">{summary}</span>
            </li>
          ) : (
            <li key={p.name} className="content-state-builtin" title={t("Made by {option} — set it in Properties.", { option: t(BUILT_IN_OPTION[p.name] ?? p.name) })}>
              <Icon name="settings" size={13} />
              <span className="content-element-name">{p.name}</span>
              <span className="content-element-size content-state-values">{summary}</span>
            </li>
          );
        })}
      </ul>
      {!stateProps.length && <p className="content-note">{t("One state only. Set Facing, Attaches or Waterloggable in Properties, or add a property of the block's own.")}</p>}
    </>
  );
}

function StateModelsList({ view }: { view: ContentView }) {
  const { readOnly } = view.props;
  const { t, pickedState, effectiveKey } = view.m;
  const { addStateModel, removeStateItem, pickState, stateModelNames } = view.cmd;
  return (
    <>
      <ListHeader title={t("State Models")}>
        <IconButton title={t("Add State Model")} disabled={readOnly} onClick={() => void addStateModel()}>
          <Icon name="plus" />
        </IconButton>
        <IconButton title={t("Remove State Model")} disabled={readOnly || pickedState?.kind !== STATE_PICK.model} onClick={() => pickedState && removeStateItem(pickedState)}>
          <Icon name="trash" />
        </IconButton>
      </ListHeader>
      <ul className="content-elements" role="listbox" aria-label={t("State Models")}>
        {stateModelNames.map((n) => (
          <li key={n} role="option" aria-selected={picked(view, STATE_PICK.model, n)} className={picked(view, STATE_PICK.model, n) ? "selected" : undefined} onClick={() => pickState({ kind: STATE_PICK.model, key: n })}>
            <Icon name={effectiveKey === stateModelKey(n) ? "check" : "grid"} size={13} />
            <span className="content-element-name">{n}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function VariantsList({ view }: { view: ContentView }) {
  const { readOnly } = view.props;
  const { t, pickedState, stateProps, states } = view.m;
  const { addVariant, removeStateItem, moveStateVariant } = view.cmd;
  const pickedVariant = pickedState?.kind === STATE_PICK.variant ? pickedState.key : null;
  const variantKeys = Object.keys(states?.variants ?? {});
  const at = pickedVariant === null ? -1 : variantKeys.indexOf(pickedVariant);
  return (
    <>
      <ListHeader title={t("Variants")}>
        <IconButton title={t("Add Variant")} disabled={readOnly || !stateProps.length} onClick={addVariant}>
          <Icon name="plus" />
        </IconButton>
        <IconButton title={t("Move Up")} disabled={readOnly || !pickedVariant || at <= 0} onClick={() => pickedVariant !== null && moveStateVariant(pickedVariant, -1)}>
          <Icon name="arrowUp" />
        </IconButton>
        <IconButton title={t("Move Down")} disabled={readOnly || pickedVariant === null || at >= variantKeys.length - 1} onClick={() => pickedVariant !== null && moveStateVariant(pickedVariant, 1)}>
          <Icon name="arrowDown" />
        </IconButton>
        <IconButton title={t("Remove Variant")} disabled={readOnly || pickedVariant === null} onClick={() => pickedState && removeStateItem(pickedState)}>
          <Icon name="trash" />
        </IconButton>
      </ListHeader>
      <ul className="content-elements" role="listbox" aria-label={t("Variants")}>
        {variantKeys.map((k) => (
          <VariantRow key={k} view={view} variant={k} />
        ))}
      </ul>
      {stateProps.length > 0 && !variantKeys.length && <p className="content-note">{t("Every state shows the block's model. Add a variant to show another model in some states.")}</p>}
    </>
  );
}

/** A variant: its condition, the models it shows, and its problems (or that no state ever reaches it). */
function VariantRow({ view, variant }: { view: ContentView; variant: string }) {
  const { t, states, shownVariant } = view.m;
  if (!states) return null;
  const problems = variantProblems(states, variant).map((x) => t(x.message, x.params));
  if (!problems.length && !statesShowing(states, variant)) problems.push(t("Never shown: a variant above it matches every state it would."));
  const isPicked = picked(view, STATE_PICK.variant, variant);
  return (
    <li role="option" aria-selected={isPicked} className={isPicked ? "selected" : undefined} title={problems.length ? problems.join("\n") : undefined} onClick={() => view.cmd.pickState({ kind: STATE_PICK.variant, key: variant })}>
      <Icon name={problems.length ? "warning" : shownVariant?.key === variant ? "preview" : "split"} size={13} />
      <span className="content-element-name">{variant || t("Every state")}</span>
      <span className="content-element-size content-state-values">{modelNames(states.variants?.[variant]).join(", ")}</span>
    </li>
  );
}
