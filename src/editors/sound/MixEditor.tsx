import { useEffect, useRef, useState } from "react";
import { useT } from "substrate-platform-ui";
import { audioContext, loadSound } from "./audio";
import { ClipInspector } from "./ClipInspector";
import { Browser } from "./daw/Browser";
import { type Snap } from "./daw/grid";
import { Mixer, type Strip } from "./daw/Mixer";
import { Playlist } from "./daw/Playlist";
import { Transport } from "./daw/Transport";
import { withTrack } from "./daw/TrackHeader";
import { EffectsEditor } from "./EffectsEditor";
import { type Channels, clipSound, type Mix, mixLength, playMix } from "./montage";
import "./daw/daw.css";

// A montage as a music program shows one: the transport along the top, the
// browser of sounds down the left, the playlist of tracks and clips in the
// middle, the mixer along the bottom with the selected clip's or channel's
// settings beside it — played from the playhead as the build renders it.

/** Pixels a second at first, and the zoom's range. */
const START_PPS = 160;
const MIN_PPS = 10;
const MAX_PPS = 4000;
/** Where the snap is remembered. */
const SNAP_KEY = "yog.montage.snap";

interface Props {
  path: string;
  /** The mix as written, and with its defaults. */
  mix: Mix;
  shown: Mix;
  readOnly: boolean;
  onChange: (next: Mix) => void;
}

function rememberedSnap(): Snap {
  try {
    return (localStorage.getItem(SNAP_KEY) as Snap | null) ?? "step";
  } catch {
    return "step";
  }
}

export function MixEditor({ path, mix, shown, readOnly, onChange }: Props) {
  const t = useT();
  const [buffers, setBuffers] = useState<(AudioBuffer | null)[]>([]);
  const [pps, setPps] = useState(START_PPS);
  const [snap, setSnapState] = useState<Snap>(rememberedSnap);
  const [position, setPosition] = useState(0);
  const [channels, setChannels] = useState<Channels | null>(null);
  const [clip, setClip] = useState<number | null>(null);
  const [strip, setStrip] = useState<Strip | null>(null);
  const playing = useRef<{ stop: () => void } | null>(null);
  const key = shown.clips.map(clipSound).join("\n");

  // The clips' sounds, loaded again only when their sources change.
  useEffect(() => {
    let live = true;
    const sounds = key ? key.split("\n") : [];
    void Promise.all(sounds.map((s) => loadSound(path, s).catch(() => null))).then((b) => live && setBuffers(b));
    return () => {
      live = false;
    };
  }, [path, key]);
  useEffect(() => () => playing.current?.stop(), []);

  const setSnap = (s: Snap) => {
    setSnapState(s);
    try {
      localStorage.setItem(SNAP_KEY, s);
    } catch {
      // Not remembered: this session still uses it.
    }
  };
  const length = mixLength(shown, buffers);

  /** Stops playing, the playhead left where it got to (`rewind`: back to the start). */
  const stop = (rewind = false) => {
    playing.current?.stop();
    if (rewind) setPosition(0);
  };
  const play = () => {
    stop();
    const ctx = audioContext();
    void ctx.resume();
    const from = position >= length ? 0 : position;
    const start = ctx.currentTime;
    const { sources, channels: ch } = playMix(ctx, shown, buffers, ctx.destination, start, from);
    setChannels(ch);
    let frame = 0;
    const end = (at: number) => {
      sources.forEach((s) => s.stop());
      cancelAnimationFrame(frame);
      setChannels(null);
      setPosition(at);
      playing.current = null;
    };
    const tick = () => {
      const now = from + ctx.currentTime - start;
      if (now >= length) return end(length);
      setPosition(now);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    playing.current = { stop: () => end(from + ctx.currentTime - start) };
  };

  const tracks = Math.max(shown.tracks?.length ?? 0, ...shown.clips.map((c) => (c.track ?? 0) + 1), 1);
  const stripEffects = strip === "master" ? mix.effects : strip !== null ? mix.tracks?.[strip]?.effects : undefined;
  const setStripEffects = (effects: Mix["effects"]) => {
    const fx = effects?.length ? effects : undefined;
    onChange(strip === "master" ? { ...mix, effects: fx } : withTrack(mix, strip as number, { effects: fx }));
  };
  const setClipAt = (i: number, next: Mix["clips"][number] | null) => onChange({ ...mix, clips: next ? mix.clips.map((c, j) => (j === i ? next : c)) : mix.clips.filter((_, j) => j !== i) });

  return (
    <div className="daw">
      <Transport
        playing={!!channels}
        position={position}
        length={length}
        tempo={shown.tempo ?? 0}
        beatsPerBar={shown.beats_per_bar ?? 0}
        snap={snap}
        readOnly={readOnly}
        onPlay={play}
        onStop={() => (channels ? stop() : stop(true))}
        onTempo={(tempo, beats) => onChange({ ...mix, tempo, beats_per_bar: beats })}
        onSnap={setSnap}
        onZoom={(f) => setPps(Math.min(MAX_PPS, Math.max(MIN_PPS, pps * f)))}
      />
      <div className="daw-middle">
        <Browser path={path} />
        <Playlist
          mix={mix}
          shown={shown}
          buffers={buffers}
          pps={pps}
          snap={snap}
          position={position}
          selected={clip}
          readOnly={readOnly}
          onSelect={(i) => (setClip(i), i !== null && setStrip(null))}
          onChange={onChange}
          onSeek={(at) => (stop(), setPosition(at))}
        />
      </div>
      <div className="daw-bottom">
        <Mixer mix={mix} shown={shown} tracks={tracks} channels={channels} selected={strip} readOnly={readOnly} onSelect={(s) => (setStrip(s), setClip(null))} onChange={onChange} />
        <div className="daw-inspector">
          {clip !== null && mix.clips[clip] ? (
            <>
              <ClipInspector clip={mix.clips[clip]} shown={shown.clips[clip] ?? mix.clips[clip]} readOnly={readOnly} onChange={(next) => setClipAt(clip, next)} />
              {!readOnly && <button onClick={() => (setClipAt(clip, null), setClip(null))}>{t("Remove the clip")}</button>}
            </>
          ) : strip !== null ? (
            <>
              <div className="sound-clip-subtitle">{strip === "master" ? t("Master's effects") : t("Track {n}'s effects", { n: strip + 1 })}</div>
              <EffectsEditor effects={stripEffects ?? []} readOnly={readOnly} onChange={setStripEffects} />
            </>
          ) : (
            <div className="daw-hint">{t("Drag a sound from the browser onto a track; select a clip or a mixer channel to edit it.")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
