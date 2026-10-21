// The advancements screen as the backend drew it, at scale `k`: hovered and
// clicked here, and dragged by sliding the picture of the tab's contents
// under the window — the backend is asked again only when the drag ends.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

type Point = { x: number; y: number };
type Box = [number, number, number, number];

/** The view's contents over every scroll the tab takes (`designer::advancements::layer`). */
export interface Layer {
  image: string;
  /** The window and its title alone, laid over the slid contents. */
  window: string;
  size: [number, number];
  /** Where its top left is from the view's, at the drag drawn. */
  at: [number, number];
  dragMin: [number, number];
  dragMax: [number, number];
}

/** The screen the backend draws (`designer::advancements::Rendered`), GUI pixels. */
export interface Rendered {
  image: string | null;
  size: [number, number];
  view: Box;
  spots: { id: string; rect: Box }[];
  drag: [number, number];
  layer: Layer | null;
}

/** A drag under way: the layer it slides, the drag it was drawn at, the drag now. */
interface Slide {
  layer: Layer;
  from: [number, number];
  now: [number, number];
  /** Let go: shown until the backend's screen for it comes. */
  done: boolean;
}

const inside = (p: Point, [x, y, w, h]: Box) => p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function AdvancementScreen({ drawn, k, onHover, onOpen, onDrag }: { drawn: Rendered; k: number; onHover: (id: string | null) => void; onOpen: (id: string) => void; onDrag: (drag: [number, number]) => void }) {
  // The last contents drawn, with the spots they were drawn for: a hover's
  // screen comes without them, and they stay right while the tree does.
  const last = useRef<{ layer: Layer; spots: string; drag: [number, number] } | null>(null);
  const spots = JSON.stringify(drawn.spots);
  if (drawn.layer) last.current = { layer: drawn.layer, spots, drag: drawn.drag };
  const [slide, setSlide] = useState<Slide | null>(null);
  const sliding = useRef(false);
  // The backend's screen for the drag let go of has come: it's shown instead.
  useEffect(() => setSlide((s) => (s?.done ? null : s)), [drawn]);

  const gui = (e: { clientX: number; clientY: number; currentTarget: Element }): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  };
  const spotAt = (p: Point) => (inside(p, drawn.view) ? (drawn.spots.find((s) => inside(p, s.rect))?.id ?? null) : null);

  const startDrag = (e: ReactPointerEvent) => {
    const layer = last.current?.spots === spots ? last.current : null;
    const start = { x: e.clientX, y: e.clientY, from: layer?.drag ?? drawn.drag };
    const at = (ev: PointerEvent): [number, number] => {
      const d: [number, number] = [start.from[0] + (ev.clientX - start.x) / k, start.from[1] + (ev.clientY - start.y) / k];
      return layer ? [clamp(d[0], layer.layer.dragMin[0], layer.layer.dragMax[0]), clamp(d[1], layer.layer.dragMin[1], layer.layer.dragMax[1])] : d;
    };
    sliding.current = true;
    onHover(null);
    if (layer) setSlide({ layer: layer.layer, from: layer.drag, now: layer.drag, done: false });
    const move = (ev: PointerEvent) => (layer ? setSlide((s) => s && { ...s, now: at(ev) }) : onDrag(at(ev)));
    const up = (ev: PointerEvent) => {
      sliding.current = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (layer) setSlide((s) => s && { ...s, done: true });
      onDrag(at(ev));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const px = (v: number) => v * k;
  return (
    <div className="adv-screen-box" style={{ width: px(drawn.size[0]), height: px(drawn.size[1]) }}>
      <img
        className="adv-screen game-icon"
        src={drawn.image ?? undefined}
        alt=""
        draggable={false}
        style={{ width: px(drawn.size[0]), height: px(drawn.size[1]), pointerEvents: "auto" }}
        onPointerMove={(e) => !sliding.current && onHover(spotAt(gui(e)))}
        onPointerLeave={() => !sliding.current && onHover(null)}
        onPointerDown={(e) => {
          const p = gui(e);
          const id = spotAt(p);
          if (id) onOpen(id);
          else if (inside(p, drawn.view)) startDrag(e);
        }}
      />
      {slide && <SlidLayer slide={slide} view={drawn.view} size={drawn.size} px={px} />}
    </div>
  );
}

/** The contents slid by the drag so far, inside the view, the window over them. */
function SlidLayer({ slide, view, size, px }: { slide: Slide; view: Box; size: [number, number]; px: (v: number) => number }) {
  const { layer, from, now } = slide;
  // Whole pixels, as the game scrolls.
  const shift = [0, 1].map((i) => Math.floor(now[i]) - Math.floor(from[i]));
  const [vx, vy, vw, vh] = view;
  return (
    <>
      <div className="adv-slide" style={{ left: px(vx), top: px(vy), width: px(vw), height: px(vh) }}>
        <img className="game-icon" src={layer.image} alt="" draggable={false} style={{ left: px(layer.at[0] + shift[0]), top: px(layer.at[1] + shift[1]), width: px(layer.size[0]), height: px(layer.size[1]) }} />
      </div>
      <img className="adv-slide-window game-icon" src={layer.window} alt="" draggable={false} style={{ width: px(size[0]), height: px(size[1]) }} />
    </>
  );
}
