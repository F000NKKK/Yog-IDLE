// The view settings, and Ctrl+wheel zoom about the cursor.

import { useEffect, useRef } from "react";
import { setSettings, settings, type ViewSettings, ZOOMS } from "../designerModel";
import type { DesignerDocument } from "../useDesignerDocument";
import type { DesignerPicture } from "../useDesignerPicture";

/** The view settings, and Ctrl+wheel zoom about the cursor. */
export function useViewZoom(designerDocument: DesignerDocument, designerPicture: DesignerPicture) {
  const { canvasRef, view, setView, error, doc } = designerDocument;
  const { layout } = designerPicture;
  const updateView = (patch: Partial<ViewSettings>) => {
    setSettings({ ...view, ...patch });
    setView(settings);
  };

  // Ctrl+wheel (a trackpad's pinch) zooms, keeping the point under the
  // cursor in place. A native listener: React's wheel events are passive,
  // and the webview would zoom the whole window.
  const zoomRef = useRef(view.zoom);
  zoomRef.current = view.zoom;
  const hasCanvas = !!doc && !!layout && error === null;
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.deltaY === 0) return;
      e.preventDefault();
      const from = zoomRef.current;
      const i = ZOOMS.indexOf(from);
      const to = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 1 : i) + (e.deltaY < 0 ? 1 : -1)))];
      if (to === from) return;
      const r = el.getBoundingClientRect();
      const [mx, my] = [e.clientX - r.left, e.clientY - r.top];
      const [sx, sy] = [el.scrollLeft, el.scrollTop];
      updateView({ zoom: to });
      requestAnimationFrame(() => {
        el.scrollLeft = ((sx + mx) * to) / from - mx;
        el.scrollTop = ((sy + my) * to) / from - my;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasCanvas]);

  return { updateView, zoomRef, hasCanvas };
}

/** What `useViewZoom` gives. */
export type ViewZoom = ReturnType<typeof useViewZoom>;
