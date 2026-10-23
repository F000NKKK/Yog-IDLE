import { useEffect, useRef, useState } from "react";
import { Icon, useT } from "substrate-platform-ui";
import { audioContext, loadSound } from "./audio";
import { clipSound, type Mix, mixLength, playMix, renderMix } from "./montage";
import { Waveform } from "./Waveform";

// A variant that's a montage: what the build will render — its waveform,
// played — and a way into its timeline.

/** The rate a mix is rendered at for its waveform. */
const PREVIEW_RATE = 22_050;

interface Props {
  path: string;
  mix: Mix;
  editing: boolean;
  onEdit: () => void;
  onRemove: () => void;
  readOnly: boolean;
}

export function MixRow({ path, mix, editing, onEdit, onRemove, readOnly }: Props) {
  const t = useT();
  const [buffers, setBuffers] = useState<(AudioBuffer | null)[]>([]);
  const [rendered, setRendered] = useState<AudioBuffer | null>(null);
  const [playing, setPlaying] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  const key = mix.clips.map(clipSound).join("\n");
  useEffect(() => {
    let live = true;
    const sounds = key ? key.split("\n") : [];
    void Promise.all(sounds.map((s) => loadSound(path, s).catch(() => null))).then((b) => live && setBuffers(b));
    return () => {
      live = false;
    };
  }, [path, key]);
  useEffect(() => {
    let live = true;
    void renderMix(mix, buffers, PREVIEW_RATE).then((r) => live && setRendered(r));
    return () => {
      live = false;
    };
  }, [mix, buffers]);
  useEffect(() => () => stop.current?.(), []);

  const toggle = () => {
    if (stop.current) return stop.current();
    const ctx = audioContext();
    void ctx.resume();
    const sources = playMix(ctx, mix, buffers, ctx.destination, ctx.currentTime);
    const done = window.setTimeout(() => stop.current?.(), mixLength(mix, buffers) * 1000);
    stop.current = () => {
      sources.forEach((s) => s.stop());
      window.clearTimeout(done);
      stop.current = null;
      setPlaying(false);
    };
    setPlaying(true);
  };
  return (
    <div className={`sound-variant${editing ? " editing" : ""}`}>
      <button className="sound-play" onClick={toggle} disabled={!rendered} title={t(playing ? "Stop" : "Play")}>
        <Icon name={playing ? "stop" : "play"} />
      </button>
      <div className="sound-variant-main">
        <div className="sound-variant-name">
          {t("Montage of {n} clips", { n: mix.clips.length })}
          {rendered ? <span className="sound-length">{rendered.duration.toFixed(2)} s</span> : null}
        </div>
        <Waveform buffer={rendered} at={null} />
      </div>
      <button onClick={onEdit}>{t(editing ? "Close the montage" : "Edit the montage")}</button>
      <button className="sound-remove" onClick={onRemove} disabled={readOnly} title={t("Remove")}>
        <Icon name="close" />
      </button>
    </div>
  );
}
