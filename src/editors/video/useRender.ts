import { useEffect, useState } from "react";
import { type Render, Frames, render, soundOf } from "./preview";

// A `.yvideo` as edited, rendered by the CLI once the edits rest — the
// render, its frames, its sound — and why it couldn't be.

/** How long edits rest before the video is rendered again, ms. */
const SETTLE = 400;

export interface Rendered {
  render: Render | null;
  frames: Frames | null;
  sound: AudioBuffer | null;
  busy: boolean;
  error: string | null;
}

const NONE: Rendered = { render: null, frames: null, sound: null, busy: false, error: null };

/** The `.yvideo` at `path`, its document `video`, rendered. */
export function useRender(path: string, video: unknown): Rendered {
  const [out, setOut] = useState<Rendered>(NONE);
  const key = video ? JSON.stringify(video) : "";
  useEffect(() => {
    if (!key) return;
    let live = true;
    setOut((o) => ({ ...o, busy: true }));
    const timer = setTimeout(() => {
      render(path, JSON.parse(key))
        .then(async (r) => {
          const sound = await soundOf(r).catch(() => null);
          if (live) setOut({ render: r, frames: new Frames(r), sound, busy: false, error: null });
        })
        .catch((e: unknown) => live && setOut({ ...NONE, error: e instanceof Error ? e.message : String(e) }));
    }, SETTLE);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [path, key]);
  return out;
}
