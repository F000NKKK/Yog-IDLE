import { useEffect, useMemo, useState } from "react";
import { usePropertyContext, useT } from "substrate-platform-ui";
import { loadSound } from "./audio";
import { Browser, useSoundList } from "./daw/Browser";
import { type Snap } from "./daw/grid";
import { Mixer, type Strip } from "./daw/Mixer";
import { Playlist } from "./daw/Playlist";
import { Transport } from "./daw/Transport";
import { usePlayback } from "./daw/usePlayback";
import { montageProperties } from "./daw/montageProperties";
import { clipSound, type Mix, mixLength } from "./montage";
import "./daw/daw.css";

// A montage as a music program shows one: the transport along the top, the
// browser of sounds down the left, the playlist of tracks and clips in the
// middle, the mixer along the bottom; the selected clip's or channel's
// settings in the IDE's Properties — played from the playhead as the build
// renders it.

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
  const [clip, setClip] = useState<number | null>(null);
  const [strip, setStrip] = useState<Strip | null>(null);
  const key = shown.clips.map(clipSound).join("\n");
  const list = useSoundList(path);
  const sounds = useMemo(() => [...list.own, ...list.game], [list]);
  const properties = useMemo(() => montageProperties({ mix, shown, clip, strip, sounds, readOnly, t, onChange }), [mix, shown, clip, strip, sounds, readOnly, t, onChange]);
  usePropertyContext(path, { objectName: path.split(/[\\/]/).pop(), objectType: t("Montage"), objectKey: `${path}#mix`, properties });

  // The clips' sounds, loaded again only when their sources change.
  useEffect(() => {
    let live = true;
    const sounds = key ? key.split("\n") : [];
    void Promise.all(sounds.map((s) => loadSound(path, s).catch(() => null))).then((b) => live && setBuffers(b));
    return () => {
      live = false;
    };
  }, [path, key]);

  const setSnap = (s: Snap) => {
    setSnapState(s);
    try {
      localStorage.setItem(SNAP_KEY, s);
    } catch {
      // Not remembered: this session still uses it.
    }
  };
  const length = mixLength(shown, buffers);
  const { position, channels, play, stop, seek } = usePlayback(shown, buffers, length);

  const tracks = Math.max(shown.tracks?.length ?? 0, ...shown.clips.map((c) => (c.track ?? 0) + 1), 1);
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
        <Browser path={path} list={list} />
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
          onSeek={seek}
        />
      </div>
      <div className="daw-bottom">
        <Mixer mix={mix} shown={shown} tracks={tracks} channels={channels} selected={strip} readOnly={readOnly} onSelect={(s) => (setStrip(s), setClip(null))} onChange={onChange} />
      </div>
    </div>
  );
}
