// The real picture: yog-ui's own layout and render, with the game's font and textures.

import { useEffect, useMemo, useRef, useState } from "react";
import { serveMethod } from "../../../data/yogIds.generated";
import { cli } from "../../../toolchain/cli";
import { withDesignResources } from "../../../lang/designResources";
import type { ScreenDesignerProps } from "../../view/ScreenDesigner";
import { mapNode, withAttrs } from "../../model/yui";
import { type Geo, type Rendered, type RenderReply, toRect } from "../designerModel";
import type { DesignerDocument } from "../useDesignerDocument";
import type { DesignerLayout } from "./useDesignerLayout";

/** The real picture: yog-ui's own layout and render, with the game's font and textures. */
export function useRenderedPicture(props: ScreenDesignerProps, designerDocument: DesignerDocument, designerLayout: DesignerLayout) {
  const { path } = props;
  const { view, doc } = designerDocument;
  const { res, resourcesVersion, componentsRevision } = designerLayout;
  // ── The real picture ──────────────────────────────────────────────────────
  // yog-ui's own layout and render — the code the game runs — drawn with the
  // game's font and textures, read from the local Minecraft client jar
  // (`src-tauri/src/designer`). Without a jar, `layout.ts` stands in.

  const [previewing, setPreviewing] = useState(false);
  /** Preview: what was typed into each text box, by uid. */
  const [previewTexts, setPreviewTexts] = useState<Record<string, string>>({});
  const [focusedBox, setFocusedBox] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  const [previewTick, setPreviewTick] = useState(0);
  const [lastEvent, setLastEvent] = useState<string | null>(null);
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const renderSeq = useRef(0);

  /** What's drawn: the document — in the preview with what was typed into its text boxes, and vanilla's `_` caret in the focused one. */
  const drawnRoot = useMemo(() => {
    if (!doc) return null;
    if (!previewing) return doc.root;
    let root = doc.root;
    const boxes = new Set([...Object.keys(previewTexts), ...(focusedBox ? [focusedBox] : [])]);
    for (const uid of boxes) {
      root = mapNode(root, uid, (n) => {
        const typed = previewTexts[uid] ?? (n.attrs.text?.startsWith("@") && !n.attrs.text.startsWith("@@") ? "" : (n.attrs.text ?? ""));
        const shown = uid === focusedBox ? `${typed}_` : typed;
        return withAttrs(n, { text: shown === "" ? undefined : shown.startsWith("@") ? `@${shown}` : shown });
      });
    }
    return root;
  }, [doc, previewing, previewTexts, focusedBox]);

  useEffect(() => {
    if (!drawnRoot) return;
    const seq = ++renderSeq.current;
    const scale = Math.min(8, view.zoom * Math.max(1, Math.round(window.devicePixelRatio || 1)));
    const { w, h } = res;
    // A short debounce: typing in the XAML re-parses on every key.
    const timer = setTimeout(() => {
      cli<RenderReply>(serveMethod.YUI_DESIGNER_RENDER, { args: { path, root: withDesignResources(drawnRoot), screenW: w, screenH: h, scale, preview: previewing } })
        .then((reply) => {
          if (seq !== renderSeq.current) return;
          const geo = new Map<string, Geo>(reply.rects.map((r) => [r.uid, { rect: toRect(r.rect), content: toRect(r.content), grid: r.grid }]));
          setRendered({ root: drawnRoot, w, h, image: reply.image, geo, assets: reply.assets, realFont: reply.realFont });
          setRenderError(null);
        })
        .catch((err) => {
          if (seq !== renderSeq.current) return;
          setRendered(null);
          setRenderError(String(err instanceof Error ? err.message : err));
        });
    }, 16);
    return () => clearTimeout(timer);
  }, [path, drawnRoot, res, view.zoom, previewing, previewTick, resourcesVersion, componentsRevision]);

  useEffect(() => () => void cli(serveMethod.YUI_DESIGNER_RESET, { path }).catch(() => {}), [path]);

  /** The picture for this GUI size (possibly of the previous edit, until the next one arrives). */

  return { previewing, setPreviewing, previewTexts, setPreviewTexts, focusedBox, setFocusedBox, hovered, setHovered, pressed, setPressed, previewTick, setPreviewTick, lastEvent, setLastEvent, rendered, setRendered, renderError, setRenderError, renderSeq, drawnRoot };
}

/** What `useRenderedPicture` gives. */
export type RenderedPicture = ReturnType<typeof useRenderedPicture>;
