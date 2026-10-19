// The preview: the screen running live, its events, zoom and panning.

import type { DesignerCommands } from "./useDesignerCommands";
import type { DesignerDocument } from "./useDesignerDocument";
import type { DesignerPicture } from "./useDesignerPicture";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef } from "react";
import { eventKey, useKeybinding } from "substrate-platform-ui";
import { cli } from "../../cli";
import { yui } from "../../data/yogIds.generated";
import { emitTo, EVENT } from "../../events";
import { withDesignResources } from "../../lang/designResources";
import { findNode, findParent, type YuiNode } from "../yui";
import { type EventReply, setSettings, settings, type ViewSettings, ZOOMS } from "./designerModel";
import type { ScreenDesignerProps } from "../ScreenDesigner";

/** The preview: the screen running live, its events, zoom and panning. */
export function useDesignerPreview(props: ScreenDesignerProps, designerDocument: DesignerDocument, designerPicture: DesignerPicture, designerCommands: DesignerCommands) {
  const { path, readOnly } = props;
  const { canvasRef, view, setView, error, sessionRef, draggingRef, doc } = designerDocument;
  const { res, layout, previewing, setPreviewing, previewTexts, setPreviewTexts, focusedBox, setFocusedBox, setHovered, setPressed, setPreviewTick, setLastEvent, rendered, drawnRoot, geo } = designerPicture;
  const { commands } = designerCommands;
  // ── Preview ───────────────────────────────────────────────────────────────

  const pageRef = useRef<HTMLDivElement>(null);
  const drawnRef = useRef(drawnRoot);
  drawnRef.current = drawnRoot;
  const eventBusy = useRef(false);
  const queuedMove = useRef<[string, number, number] | null>(null);

  /** An event the screen would get: the status bar and Output show it, as the game's code-behind would receive it. */
  const fired = (what: string) => {
    setLastEvent(what);
    emitTo(EVENT.ideOutput, `[designer] ${what}`);
  };

  const sendEvent = (event: string, x: number, y: number) => {
    const root = drawnRef.current;
    if (!root) return;
    const motion = event.startsWith("move:") || event.startsWith("drag:");
    if (motion && eventBusy.current) {
      queuedMove.current = [event, x, y];
      return;
    }
    eventBusy.current = true;
    cli<EventReply>("yui_designer_event", { args: { path, root: withDesignResources(root), screenW: res.w, screenH: res.h, event, x, y } })
      .then((r) => {
        setHovered(r.hit);
        if (event.startsWith("click:")) setPressed(r.hit);
        if (r.scrolled) setPreviewTick((n) => n + 1);
        if (r.clicked) fired(`click: ${r.clicked}`);
      })
      .catch(() => {})
      .finally(() => {
        eventBusy.current = false;
        const next = queuedMove.current;
        queuedMove.current = null;
        if (next) sendEventRef.current(...next);
      });
  };
  const sendEventRef = useRef(sendEvent);
  sendEventRef.current = sendEvent;

  const togglePreview = () => {
    if (previewing) void cli("yui_designer_reset", { path }).catch(() => {});
    setPreviewTexts({});
    setFocusedBox(null);
    setHovered(null);
    setPressed(null);
    setLastEvent(null);
    setPreviewing(!previewing);
  };

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

  const focused = () => {
    const el = document.activeElement;
    return !!el && el.classList.contains("sp-design-surface") && !!canvasRef.current?.contains(el);
  };
  const editable = () => focused() && !readOnly;
  const keyOpts = { when: editable };
  useKeybinding(["Delete"], () => commands.current.deleteSelection(), keyOpts);
  useKeybinding("Ctrl+C", () => void commands.current.copySelection(), { when: focused });
  useKeybinding("Ctrl+X", () => void (commands.current.copySelection() && commands.current.deleteSelection()), keyOpts);
  useKeybinding("Ctrl+V", () => commands.current.paste(), keyOpts);
  useKeybinding("Ctrl+D", () => commands.current.duplicate(), keyOpts);
  useKeybinding(
    "Ctrl+A",
    () => {
      const s = sessionRef.current;
      if (s) commands.current.select(s.doc.root.children.map((c) => c.uid));
    },
    { when: focused }
  );
  useKeybinding(
    "Escape",
    () => {
      const s = sessionRef.current;
      if (draggingRef.current || !s || s.selection.length === 0) return false;
      const parent = findParent(s.doc.root, s.selection[0]);
      commands.current.select(parent ? [parent.uid] : []);
    },
    { when: focused }
  );
  // Arrows move a widget 1px (Ctrl: 8px); with Shift they resize it.
  const ARROWS: Record<string, [number, number]> = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
  useKeybinding(
    ["Left", "Right", "Up", "Down"].flatMap((k) => [k, `Ctrl+${k}`, `Shift+${k}`, `Ctrl+Shift+${k}`]),
    (e) => {
      const [dx, dy] = ARROWS[e.key.toLowerCase()] ?? [0, 0];
      const by = e.ctrlKey || e.metaKey ? 8 : 1;
      commands.current.nudge(dx * by, dy * by, e.shiftKey);
    },
    keyOpts
  );

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

  return { pageRef, drawnRef, eventBusy, queuedMove, fired, sendEvent, sendEventRef, togglePreview, guiPoint, fmt, textBoxAt, typeInto, onPreviewKey, focused, editable, keyOpts, ARROWS, updateView, zoomRef, hasCanvas };
}

/** What `useDesignerPreview` gives the component. */
export type DesignerPreview = ReturnType<typeof useDesignerPreview>;
