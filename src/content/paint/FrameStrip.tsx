import { useEffect, useMemo, useState } from "react";
import { Toolbar, ToolbarButton, ToolbarCheck, ToolbarGroup, ToolbarLabel, Spacer, useT } from "substrate-platform-ui";
import { addImageFrame, cropFrame, entryAt, TICKS_PER_SECOND, type TextureAnimation } from "../animation";
import type { PixelImage } from "./pixels";
import "./FrameStrip.css";

export interface FrameStripProps {
  image: PixelImage;
  animation: TextureAnimation;
  /** The entry of `animation.frames` being painted. */
  selected: number;
  onSelect: (entry: number) => void;
  /** Playing: the canvas and the 3D view run the animation. */
  playing: boolean;
  onPlaying: (playing: boolean) => void;
  /** An edit: the new animation, and the new image when frames were added. */
  onChange: (animation: TextureAnimation, image?: PixelImage) => void;
  readOnly?: boolean;
}

/** A frame's pixels as an image URL, for its tile. */
function frameUrl(img: PixelImage): string {
  const c = document.createElement("canvas");
  c.width = img.w;
  c.height = img.h;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.w, img.h), 0, 0);
  return c.toDataURL();
}

/**
 * An animated texture's frames, as the game plays them (`.png.mcmeta`):
 * one tile per step with its time in ticks — pick one to paint it, play
 * them, change a step's time, duplicate, remove or move steps.
 */
export function FrameStrip({ image, animation, selected, onSelect, playing, onPlaying, onChange, readOnly }: FrameStripProps) {
  const t = useT();
  const frames = animation.frames;
  const entry = Math.min(selected, frames.length - 1);
  const current = frames[entry];
  const urls = useMemo(() => {
    const out = new Map<number, string>();
    for (const f of frames) if (!out.has(f.index)) out.set(f.index, frameUrl(cropFrame(image, animation, f.index)));
    return out;
  }, [image, animation, frames]);

  // Playing: the tile shown moves with the game's clock.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const start = performance.now();
    const timer = window.setInterval(() => setTick(((performance.now() - start) / 1000) * TICKS_PER_SECOND), 1000 / TICKS_PER_SECOND);
    return () => window.clearInterval(timer);
  }, [playing]);
  useEffect(() => {
    if (playing) onSelect(entryAt(animation, tick));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, playing]);

  const withFrames = (next: TextureAnimation["frames"], img?: PixelImage) => onChange({ ...animation, frames: next }, img);
  const setTime = (time: number) => withFrames(frames.map((f, i) => (i === entry ? { ...f, time: Math.max(1, Math.round(time)) } : f)));
  const duplicate = () => {
    const { img, index } = addImageFrame(image, animation, current.index);
    const next = [...frames];
    next.splice(entry + 1, 0, { index, time: current.time });
    withFrames(next, img);
    onSelect(entry + 1);
  };
  const remove = () => {
    if (frames.length < 2) return;
    withFrames(frames.filter((_, i) => i !== entry));
    onSelect(Math.max(0, entry - 1));
  };
  const move = (by: number) => {
    const to = entry + by;
    if (to < 0 || to >= frames.length) return;
    const next = [...frames];
    [next[entry], next[to]] = [next[to], next[entry]];
    withFrames(next);
    onSelect(to);
  };

  return (
    <div className="frame-strip">
      <Toolbar>
        <ToolbarGroup>
          <ToolbarButton icon={playing ? "stop" : "play"} label={playing ? "Stop" : "Play"} onClick={() => onPlaying(!playing)} />
          <ToolbarLabel>{t("Frame {n} of {count}", { n: entry + 1, count: frames.length })}</ToolbarLabel>
        </ToolbarGroup>
        <ToolbarGroup>
          <label className="frame-strip-time" title={t("How long this frame shows, in ticks (20 a second)")}>
            {t("Time")}
            <input type="number" min={1} value={current.time} disabled={readOnly || playing} onChange={(e) => setTime(Number(e.target.value) || 1)} />
            <span>{t("ticks")}</span>
          </label>
        </ToolbarGroup>
        <ToolbarGroup>
          <ToolbarButton icon="plus" label="Duplicate frame" disabled={readOnly || playing} onClick={duplicate} />
          <ToolbarButton icon="arrowUp" label="Earlier" disabled={readOnly || playing || entry === 0} onClick={() => move(-1)} />
          <ToolbarButton icon="arrowDown" label="Later" disabled={readOnly || playing || entry === frames.length - 1} onClick={() => move(1)} />
          <ToolbarButton icon="trash" label="Remove frame" disabled={readOnly || playing || frames.length < 2} onClick={remove} />
        </ToolbarGroup>
        <Spacer />
        <ToolbarCheck label="Blend frames" checked={animation.interpolate} disabled={readOnly} onChange={(interpolate) => onChange({ ...animation, interpolate })} />
      </Toolbar>
      <div className="frame-strip-tiles" role="listbox" aria-label={t("Frames")}>
        {frames.map((f, i) => (
          <button
            key={i}
            type="button"
            role="option"
            aria-selected={i === entry}
            className="frame-strip-tile"
            title={t("Frame {n}: image frame {index}, {time} ticks", { n: i + 1, index: f.index, time: f.time })}
            onClick={() => {
              onPlaying(false);
              onSelect(i);
            }}
          >
            <img src={urls.get(f.index)} alt="" draggable={false} />
            <span>{f.time}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
