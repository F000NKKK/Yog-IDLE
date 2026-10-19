import { useEffect, useMemo, useRef, useState } from "react";
import type { Vec3 } from "./model";
import { buildModel } from "./viewport/buildModel";
import { CENTER, VIEWS } from "./viewport/scene";
import { createThree } from "./viewport/threeView";
import { useRenderer } from "./viewport/useRenderer";
import { type InputProps, useViewportInput } from "./viewport/useViewportInput";
import type { ViewportProps } from "./viewport/viewportTypes";

// The model editor's 3D view: Minecraft model elements drawn with nearest
// filtering and Minecraft's per-face shading, an orbit camera that handles
// like Blender's (middle drag orbits, Shift+middle pans, wheel zooms, numpad
// 1/3/7 front/side/top, 5 perspective/orthographic), a grid with the block's
// bounds, an axes gizmo, click-to-select, and move/resize handles that snap
// to Minecraft's pixel grid. One unit = one model pixel.

export type { GizmoMode, PaintHit, Part, TextureSource, ViewName, ViewportProps } from "./viewport/viewportTypes";

export function Viewport(props: ViewportProps) {
  const { parts, images, selected, selectedFace, onSelect, onTransform, gizmo, shading, showGrid, renderLayer, display, onPaint, viewRequest, style, className } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const [ortho, setOrtho] = useState(false);
  const [loaded, setLoaded] = useState(0);
  /** An element being dragged: its live from/to. */
  const [drag, setDrag] = useState<{ index: number; from: Vec3; to: Vec3 } | null>(null);
  const three = useMemo(createThree, []);
  const invalidate = useRef(() => {});
  useRenderer(hostRef, three, ortho, invalidate);

  // Jump to a view.
  useEffect(() => {
    if (!viewRequest) return;
    const v = VIEWS[viewRequest.view];
    three.cam.theta = v.theta;
    three.cam.phi = v.phi;
    three.cam.target.copy(CENTER);
    setOrtho(true);
    invalidate.current();
  }, [viewRequest, three]);

  // The model, rebuilt when anything it shows changes.
  useEffect(() => {
    three.grid.visible = showGrid;
    const onLoad = () => setLoaded((n) => n + 1);
    const disposables = buildModel(three, { parts, images, selected, selectedFace, shading, renderLayer, display, onTransform, gizmo, drag, onLoad });
    invalidate.current();
    return () => {
      for (const d of disposables) d.dispose();
    };
  }, [three, parts, images, selected, selectedFace, shading, showGrid, renderLayer, display, drag, gizmo, onTransform, loaded]);

  const propsRef = useRef<InputProps>({ parts, onSelect, onTransform, selected, onPaint });
  propsRef.current = { parts, onSelect, onTransform, selected, onPaint };
  useViewportInput({ hostRef, three, ortho, propsRef, invalidate, setDrag, setOrtho });

  return (
    <div
      ref={hostRef}
      className={className}
      tabIndex={0}
      style={{ position: "relative", overflow: "hidden", outline: "none", cursor: onPaint ? "crosshair" : undefined, ...style }}
      data-ortho={ortho || undefined}
    >
      <div className="content-viewport-hud">{ortho ? "Ortho" : "Persp"}</div>
    </div>
  );
}
