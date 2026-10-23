// Preview mode: events sent to the screen's code, one at a time.

import { useRef } from "react";
import { serveMethod } from "../../../data/yogIds.generated";
import { cli } from "../../../toolchain/cli";
import { emitTo, EVENT } from "../../../app/events";
import { withDesignResources } from "../../../lang/designResources";
import type { ScreenDesignerProps } from "../../view/ScreenDesigner";
import type { EventReply } from "../designerModel";
import type { DesignerPicture } from "../useDesignerPicture";

/** Preview mode: events sent to the screen's code, one at a time. */
export function usePreviewEvents(props: ScreenDesignerProps, designerPicture: DesignerPicture) {
  const { path } = props;
  const { res, previewing, setPreviewing, setPreviewTexts, setFocusedBox, setHovered, setPressed, setPreviewTick, setLastEvent, drawnRoot } = designerPicture;
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
    cli<EventReply>(serveMethod.YUI_DESIGNER_EVENT, { args: { path, root: withDesignResources(root), screenW: res.w, screenH: res.h, event, x, y } })
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
    if (previewing) void cli(serveMethod.YUI_DESIGNER_RESET, { path }).catch(() => {});
    setPreviewTexts({});
    setFocusedBox(null);
    setHovered(null);
    setPressed(null);
    setLastEvent(null);
    setPreviewing(!previewing);
  };

  return { pageRef, drawnRef, eventBusy, queuedMove, fired, sendEvent, sendEventRef, togglePreview };
}

/** What `usePreviewEvents` gives. */
export type PreviewEvents = ReturnType<typeof usePreviewEvents>;
