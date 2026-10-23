import { useEffect, useRef } from "react";
import * as THREE from "three";
import { type Live, type ParticleLook, spawn, tick } from "./particleSim";
import { type Frames, MAX_PARTICLES, ParticleView } from "./particleView";

// The particle preview: the game's 20 ticks a second, drawn every frame in
// between; an emitter (the preview's, not the file's) spraying the particle
// a block above the ground; the camera turned by dragging, moved by the wheel.

/** The game's tick, ms. */
const TICK_MS = 50;
/** Where the emitter is, and the ground. */
const EMITTER = new THREE.Vector3(0, 1, 0);
const FLOOR = 0;
/** Radians the camera turns a dragged pixel; how much a wheel notch zooms. */
const DRAG_TURN = 0.01;
const WHEEL_ZOOM = 1.1;
/** Ticks a frame may catch up on (a hidden tab comes back). */
const MAX_CATCH_UP = 10;

/** How the preview sprays: particles a tick, their speed, their colour (`0xRRGGBB`). */
export interface Emitter {
  rate: number;
  speed: number;
  color: number;
}

interface Props {
  look: ParticleLook | null;
  frames: Frames | null;
  emitter: Emitter;
  playing: boolean;
  night: boolean;
  /** Changes to start over: every particle gone. */
  restart: number;
}

/** A direction at random, evenly over the sphere. */
function randomDirection(): [number, number, number] {
  const th = Math.random() * Math.PI * 2;
  const y = Math.random() * 2 - 1;
  const r = Math.sqrt(1 - y * y);
  return [r * Math.cos(th), y, r * Math.sin(th)];
}

export function ParticleViewport({ look, frames, emitter, playing, night, restart }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<ParticleView | null>(null);
  const live = useRef<Live[]>([]);
  const state = useRef({ look, frames, emitter, playing, night, owed: 0 });
  state.current = { ...state.current, look, frames, emitter, playing, night };

  useEffect(() => {
    if (!canvas.current) return;
    const v = new ParticleView(canvas.current, EMITTER);
    view.current = v;
    const fit = new ResizeObserver(([e]) => v.resize(e.contentRect.width, e.contentRect.height));
    fit.observe(canvas.current);
    let last = performance.now(), since = 0, frame = 0;
    const loop = (now: number) => {
      const s = state.current;
      since += s.playing ? now - last : 0;
      last = now;
      let ticks = 0;
      while (since >= TICK_MS && ticks++ < MAX_CATCH_UP) {
        since -= TICK_MS;
        step(s.look, s.frames, s.emitter, live.current, state.current);
      }
      if (ticks > MAX_CATCH_UP) since = 0;
      v.draw(live.current, since / TICK_MS, s.night, !!s.look?.render.glow);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      fit.disconnect();
      v.dispose();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    if (look) view.current?.setRender(look.render);
  }, [look]);
  useEffect(() => {
    if (frames) view.current?.setFrames(frames);
  }, [frames]);
  useEffect(() => {
    live.current = [];
  }, [restart, look]);

  const drag = (e: React.PointerEvent) => {
    if (e.buttons !== 1) return;
    view.current?.turn(e.movementX * DRAG_TURN, -e.movementY * DRAG_TURN);
  };
  const wheel = (e: React.WheelEvent) => view.current?.turn(0, 0, e.deltaY > 0 ? WHEEL_ZOOM : 1 / WHEEL_ZOOM);
  return <canvas ref={canvas} className="particle-viewport" onPointerMove={drag} onWheel={wheel} />;
}

/** One tick: every particle moved (the gone left out), then the emitter's new ones. */
function step(look: ParticleLook | null, frames: Frames | null, emitter: Emitter, live: Live[], s: { owed: number }) {
  if (!look) return;
  const count = frames?.count ?? 1;
  for (const p of live) tick(look, p, count, FLOOR);
  const kept = live.filter((p) => !p.removed);
  s.owed += emitter.rate;
  while (s.owed >= 1 && kept.length < MAX_PARTICLES) {
    s.owed -= 1;
    const dir = randomDirection().map((d) => d * emitter.speed) as [number, number, number];
    kept.push(spawn(look, [EMITTER.x, EMITTER.y, EMITTER.z], dir, emitter.color, count));
  }
  live.splice(0, live.length, ...kept);
}
