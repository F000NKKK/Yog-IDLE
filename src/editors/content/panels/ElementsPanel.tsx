import { Icon, IconButton, Spacer, withShortcut } from "substrate-platform-ui";
import { DIRS } from "../../../content/model";
import type { ContentView } from "../contentView";
import { fmt } from "../fieldText";

/** The model's elements: listed with their sizes, added, duplicated, reordered, deleted — and the selected one's faces. */
export function ElementsPanel({ view }: { view: ContentView }) {
  const { readOnly } = view.props;
  const { t, resolved, elements, sel, model } = view.m;
  const { addElement, duplicateElement, deleteElement, moveElement } = view.cmd;
  const { onSelect } = view.tx;
  return (
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
      {!resolved.own && elements.length > 0 && <p className="content-note">{t("These elements come from {parent}. Editing one copies them into this model.", { parent: model?.parent ?? "" })}</p>}
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
      <FaceButtons view={view} />
    </>
  );
}

/** The selected element's six faces, one picked (greyed where it has none). */
function FaceButtons({ view }: { view: ContentView }) {
  const { t, selEl, face, sel } = view.m;
  if (!selEl) return null;
  return (
    <div className="content-faces">
      {DIRS.map((d) => (
        <button key={d} type="button" className={`content-face${face === d ? " selected" : ""}${selEl.faces[d] ? "" : " off"}`} onClick={() => view.tx.onSelect(sel, d)}>
          {t(d)}
        </button>
      ))}
    </div>
  );
}
