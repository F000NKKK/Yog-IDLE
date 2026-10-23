import { useEffect, useRef, useState } from "react";
import { Icon, useT } from "substrate-platform-ui";
import { loadSound, play, type Playing } from "./audio";
import { Waveform } from "./Waveform";
import { soundLabel, soundName } from "./names";

// One sound an event may play: what it is, its waveform, played as the
// game plays it (its volume and pitch), and its volume, pitch and weight.

/** A variant as `format.complete` gives it. */
export interface Variant {
  sound?: string | null;
  file?: string | null;
  volume?: number | null;
  pitch?: number | null;
  weight?: number | null;
  stream?: boolean;
  preload?: boolean;
  attenuation_distance?: number | null;
}

/** What the game takes when a variant doesn't say. */
export const GAME_VOLUME = 1;
export const GAME_PITCH = 1;
export const GAME_WEIGHT = 1;

/** How often the playhead moves, ms. */
const HEAD_MS = 30;
const MS = 1000;

/** The sound a variant plays, as the CLI's `sound_data` takes it. */
export const soundOf = (v: Variant) => v.sound ?? v.file ?? "";

interface Props {
  path: string;
  variant: Variant;
  readOnly: boolean;
  onChange: (next: Variant) => void;
  onRemove: () => void;
}

export function VariantRow({ path, variant, readOnly, onChange, onRemove }: Props) {
  const t = useT();
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const playing = useRef<Playing | null>(null);
  const sound = soundOf(variant);
  useEffect(() => {
    let live = true;
    setBuffer(null);
    setError(null);
    loadSound(path, sound).then(
      (b) => live && setBuffer(b),
      (e) => live && setError(String((e as { message?: string })?.message ?? e)),
    );
    return () => {
      live = false;
    };
  }, [path, sound]);
  useEffect(() => () => playing.current?.stop(), []);

  const toggle = () => {
    if (playing.current) return playing.current.stop();
    if (!buffer) return;
    const pitch = variant.pitch ?? GAME_PITCH;
    const p = play(buffer, variant.volume ?? GAME_VOLUME, pitch);
    playing.current = p;
    const started = performance.now(), length = (buffer.duration / pitch) * MS;
    const head = window.setInterval(() => setAt(Math.min(1, (performance.now() - started) / length)), HEAD_MS);
    void p.ended.then(() => {
      window.clearInterval(head);
      setAt(null);
      playing.current = null;
    });
  };

  const number = (key: "volume" | "pitch" | "weight", fallback: number, step: number) => (
    <input
      type="number"
      step={step}
      min={0}
      value={variant[key] ?? fallback}
      disabled={readOnly}
      onChange={(e) => onChange({ ...variant, [key]: e.target.value === "" ? null : Number(e.target.value) })}
    />
  );
  return (
    <div className="sound-variant">
      <button className="sound-play" onClick={toggle} disabled={!buffer} title={t(at === null ? "Play" : "Stop")}>
        <Icon name={at === null ? "play" : "stop"} />
      </button>
      <div className="sound-variant-main">
        <div className="sound-variant-name">
          {variant.file ? <span className="sound-game">{t("game")}</span> : <span className="sound-game">{soundName(sound).set}</span>}
          {soundLabel(sound)}
          {buffer ? <span className="sound-length">{buffer.duration.toFixed(2)} s</span> : null}
        </div>
        {error ? <div className="sound-error">{error}</div> : <Waveform buffer={buffer} at={at} />}
      </div>
      <label>
        {t("Volume")}
        {number("volume", GAME_VOLUME, 0.05)}
      </label>
      <label>
        {t("Pitch")}
        {number("pitch", GAME_PITCH, 0.05)}
      </label>
      <label>
        {t("Weight")}
        {number("weight", GAME_WEIGHT, 1)}
      </label>
      <button className="sound-remove" onClick={onRemove} disabled={readOnly} title={t("Remove")}>
        <Icon name="close" />
      </button>
    </div>
  );
}
