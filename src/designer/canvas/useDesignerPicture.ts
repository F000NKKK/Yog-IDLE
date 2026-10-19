// How the screen lays out, and the real picture the game draws of it.

import type { DesignerDocument } from "./useDesignerDocument";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DesignItem } from "substrate-platform-ui";
import { cli } from "../../cli";
import { useDesignResources, withDesignResources } from "../../lang/designResources";
import { modRootOf } from "../../paths";
import { designRoot, isComponentDoc, useComponents } from "../components";
import { compute, screenWidget } from "../layout";
import { isContainer, mapNode, withAttrs, type YuiNode } from "../yui";
import { collect, type Geo, nodeLabel, positioned, type Rendered, type RenderReply, RESOLUTIONS, toRect } from "./designerModel";
import type { ScreenDesignerProps } from "../ScreenDesigner";

/** How the screen lays out, and the real picture the game draws of it. */
export function useDesignerPicture(props: ScreenDesignerProps, designerDocument: DesignerDocument) {
  const { path, content } = props;
  const { view, doc } = designerDocument;
  // ── Layout ────────────────────────────────────────────────────────────────

  const res = RESOLUTIONS[view.res] ?? RESOLUTIONS[0];
  // `@Strings.title` texts shown from the mod's .yres files (docs/yres.md).
  const resourcesVersion = useDesignResources(modRootOf(path));
  // The mod's components (docs/yui.md, "Components"): what instances draw as, re-drawn when one changes.
  const components = useComponents(path);
  const componentsRevision = components ? `${components.revision}:${components.status}` : "";
  const layout = useMemo(() => {
    if (!doc) return null;
    const widget = screenWidget(designRoot(doc.root), res.w, res.h);
    const tree = compute(widget, res.w, res.h);
    const geo = new Map<string, Geo>();
    collect(widget, tree, geo);
    return { widget, tree, geo };
  }, [doc, res.w, res.h, resourcesVersion]);

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
      cli<RenderReply>("yui_designer_render", { args: { path, root: withDesignResources(drawnRoot), screenW: w, screenH: h, scale, preview: previewing } })
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

  useEffect(() => () => void cli("yui_designer_reset", { path }).catch(() => {}), [path]);

  /** The picture for this GUI size (possibly of the previous edit, until the next one arrives). */
  const picture = rendered && rendered.w === res.w && rendered.h === res.h && rendered.assets ? rendered : null;
  /** Where things are: yog-ui's layout when the picture is of this very document, else `layout.ts`'s (the same rules, in TypeScript). */
  const geo = rendered && doc && rendered.root === doc.root && rendered.w === res.w && rendered.h === res.h ? rendered.geo : layout?.geo;

  const items = useMemo<DesignItem[]>(() => {
    if (!doc || !geo) return [];
    const out: DesignItem[] = [];
    const visit = (n: YuiNode, parent: YuiNode | null) => {
      const g = geo.get(n.uid);
      if (!g) return;
      const free = positioned(n, parent);
      out.push({
        id: n.uid,
        rect: g.rect,
        contentRect: g.content,
        parentId: parent?.uid ?? null,
        container: isContainer(n),
        placement: parent ? (free ? "free" : "flow") : "fixed",
        handles: parent ? undefined : n.attrs.anchor === "fill" ? [] : ["e", "s", "se"],
        label: nodeLabel(n),
      });
      if (isContainer(n) || isComponentDoc(n)) n.children.forEach((c) => visit(c, n));
    };
    visit(doc.root, null);
    return out;
  }, [doc, geo]);

  return { res, resourcesVersion, components, componentsRevision, layout, previewing, setPreviewing, previewTexts, setPreviewTexts, focusedBox, setFocusedBox, hovered, setHovered, pressed, setPressed, previewTick, setPreviewTick, lastEvent, setLastEvent, rendered, setRendered, renderError, setRenderError, renderSeq, drawnRoot, picture, geo, items };
}

/** What `useDesignerPicture` gives the component. */
export type DesignerPicture = ReturnType<typeof useDesignerPicture>;
