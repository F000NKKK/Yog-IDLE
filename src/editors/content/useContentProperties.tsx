import { Button, PROPERTY_ORDER, type PropertyDescriptor, Spacer, usePropertyContext } from "substrate-platform-ui";
import { autoUv, DIRS } from "../../content/model";
import { UvEditor } from "../../content/UvEditor";
import { kind as KIND } from "../../data/yogIds.generated";
import { STATE_SEL_TYPES } from "./contentModel";
import type { ContentView } from "./contentView";

/** The selected face's UV editor, as Properties' last row — `null` while painting or with no face picked. */
function uvRow(view: ContentView): PropertyDescriptor | null {
  const { readOnly } = view.props;
  const { t, selEl, face, sel, resolved, editElements } = view.m;
  const faceData = selEl && face ? selEl.faces[face] : undefined;
  if (view.pt.paintOn || !faceData || !face || !selEl || sel === null) return null;
  const faceTexture = resolved.textures[faceData.texture.replace(/^#/, "")];
  // The element's other faces on the same texture, drawn behind.
  const others = DIRS.filter((d) => d !== face && selEl.faces[d]?.texture === faceData.texture).map((d) => selEl.faces[d]?.uv ?? autoUv(d, selEl.from, selEl.to));
  return {
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
          <Button variant="ghost" disabled={readOnly || !faceData.uv} onClick={() => editElements((els) => void delete els[sel].faces[face]?.uv)}>
            {t("Auto UV")}
          </Button>
        </div>
        <UvEditor
          image={faceTexture ? view.pt.shownImages[faceTexture] : undefined}
          uv={faceData.uv ?? autoUv(face, selEl.from, selEl.to)}
          others={others}
          readOnly={readOnly}
          onCommit={(uv) =>
            editElements((els) => {
              const f = els[sel].faces[face];
              if (f) f.uv = uv;
            })
          }
        />
      </div>
    ),
  };
}

/**
 * What Properties shows while this editor is active: the selected element
 * (or a picked state item, or the file's own fields), the face's UV under them.
 */
export function useContentProperties(view: ContentView) {
  const { path } = view.props;
  const { t, kind, file, selEl, sel, face, pickedState, effectiveKey } = view.m;
  const uv = uvRow(view);
  usePropertyContext(path, {
    // A picked property's or variant's rows as declared: name, kind, values; conditions, models.
    order: pickedState && !selEl ? PROPERTY_ORDER.declared : PROPERTY_ORDER.sorted,
    objectName: selEl ? (selEl.name ?? `${t("Element")} ${(sel ?? 0) + 1}`) : pickedState ? pickedState.key || t("Every state") : (file.name ?? path.split(/[\\/]/).pop()),
    objectType: selEl ? t("Element") : pickedState ? t(STATE_SEL_TYPES[pickedState.kind]) : kind === KIND.BLOCK ? t("Block") : t("Item"),
    objectKey: `${effectiveKey}:${sel ?? "-"}:${face ?? "-"}:${pickedState ? `${pickedState.kind}:${pickedState.key}` : "-"}`,
    properties: uv ? [...view.cmd.properties, uv] : view.cmd.properties,
  });
}
