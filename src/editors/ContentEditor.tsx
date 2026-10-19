import { Button, type EditorProps } from "substrate-platform-ui";
import { Viewport } from "../content/Viewport";
import { kind as KIND } from "../data/yogIds.generated";
import "./ContentEditor.css";
import { ContentToolbar } from "./content/ContentToolbar";
import type { ContentView } from "./content/contentView";
import { PaintPane } from "./content/PaintPane";
import { ElementsPanel } from "./content/panels/ElementsPanel";
import { LayersPanel } from "./content/panels/LayersPanel";
import { PaintPanel } from "./content/panels/PaintPanel";
import { StatesPanel } from "./content/panels/StatesPanel";
import { useContentCommands } from "./content/useContentCommands";
import { useContentModel } from "./content/useContentModel";
import { useContentPaint } from "./content/useContentPaint";
import { useContentProperties } from "./content/useContentProperties";
import { useContentTextures } from "./content/useContentTextures";

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
  const m = useContentModel(props);
  const tx = useContentTextures(props, m);
  const pt = useContentPaint(props, m, tx);
  const cmd = useContentCommands(props, m, pt);
  const view: ContentView = { props, m, tx, pt, cmd };
  useContentProperties(view);
  const { t, parsed, rootRef, resolved, kind } = m;
  if (!parsed) return null;
  if (!parsed.ok) {
    return (
      <div className="content-editor content-broken">
        <p>{t("This file isn't valid JSON: {error}", { error: parsed.error })}</p>
        <Button onClick={cmd.viewCode}>{t("View Code")}</Button>
      </div>
    );
  }
  return (
    <div className="content-editor" ref={rootRef}>
      <ContentToolbar view={view} />
      <div className="content-body">
        <div className="content-outliner">
          {pt.paintOn && <PaintPanel view={view} />}
          {resolved.sprite ? <LayersPanel view={view} /> : <ElementsPanel view={view} />}
          {kind === KIND.BLOCK && <StatesPanel view={view} />}
        </div>
        <div className="content-center">
          {pt.paintOn && <PaintPane view={view} />}
          <ContentViewport view={view} />
        </div>
      </div>
    </div>
  );
}

/** The 3D view of the model: selection and the gizmo, or painting right on it. */
function ContentViewport({ view }: { view: ContentView }) {
  const { readOnly } = view.props;
  const { sel, face, gizmo, shading, grid, file, viewRequest } = view.m;
  const { parts, display, onSelect, onTransform } = view.tx;
  const { paintOn, shownImages, onViewportPaint } = view.pt;
  return (
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
  );
}
