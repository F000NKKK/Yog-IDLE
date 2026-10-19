// The preview's pointer and keys: points in GUI pixels, typing into a text box.

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { eventKey } from "substrate-platform-ui";
import { yui } from "../../../data/yogIds.generated";
import { findNode, type YuiNode } from "../../yui";
import type { DesignerDocument } from "../useDesignerDocument";
import type { DesignerPicture } from "../useDesignerPicture";
import type { PreviewEvents } from "./usePreviewEvents";

/** The preview's pointer and keys: points in GUI pixels, typing into a text box. */
export function usePreviewInput(designerDocument: DesignerDocument, designerPicture: DesignerPicture, previewEvents: PreviewEvents) {
  const { view, doc } = designerDocument;
  const { previewTexts, setPreviewTexts, focusedBox, setFocusedBox, rendered, geo } = designerPicture;
  const { pageRef, fired } = previewEvents;
  const guiPoint = (e: { clientX: number; clientY: number }) => {
    const r = pageRef.current?.getBoundingClientRect();
    return r ? { x: (e.clientX - r.left) / view.zoom, y: (e.clientY - r.top) / view.zoom } : { x: -1, y: -1 };
  };
  const fmt = (v: number) => v.toFixed(2);

  /** The enabled text box under a point (the last drawn wins). */
  const textBoxAt = (x: number, y: number): YuiNode | null => {
    const g = rendered?.geo ?? geo;
    let found: YuiNode | null = null;
    const visit = (n: YuiNode) => {
      const r = g?.get(n.uid)?.rect;
      if (n.kind === yui.TEXT_BOX && n.attrs.enabled !== "false" && r && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) found = n;
      n.children.forEach(visit);
    };
    if (doc) visit(doc.root);
    return found;
  };

  const typeInto = (box: YuiNode, update: (text: string) => string) => {
    const before = previewTexts[box.uid] ?? (box.attrs.text?.startsWith("@") && !box.attrs.text.startsWith("@@") ? "" : (box.attrs.text ?? ""));
    let after = update(before);
    const max = Number(box.attrs.max_length ?? 0);
    if (max > 0) after = [...after].slice(0, max).join("");
    if (after === before) return;
    setPreviewTexts({ ...previewTexts, [box.uid]: after });
    if (box.attrs.on_change) fired(`change: ${box.attrs.on_change} ${JSON.stringify(after)}`);
  };

  const onPreviewKey = (e: ReactKeyboardEvent) => {
    const box = focusedBox && doc ? findNode(doc.root, focusedBox) : null;
    if (!box) return;
    if (e.key === "Escape") setFocusedBox(null);
    else if (e.key === "Enter") {
      if (box.attrs.on_submit) fired(`submit: ${box.attrs.on_submit}`);
    } else if (e.key === "Backspace") typeInto(box, (text) => [...text].slice(0, -1).join(""));
    else if ((e.ctrlKey || e.metaKey) && eventKey(e) === "v") {
      void navigator.clipboard?.readText().then((clip) => typeInto(box, (text) => text + clip.replace(/[\r\n]/g, "")));
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) typeInto(box, (text) => text + e.key);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return { guiPoint, fmt, textBoxAt, typeInto, onPreviewKey };
}

/** What `usePreviewInput` gives. */
export type PreviewInput = ReturnType<typeof usePreviewInput>;
