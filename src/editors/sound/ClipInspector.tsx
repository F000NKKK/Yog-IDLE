import { useT } from "substrate-platform-ui";
import { EffectsEditor } from "./EffectsEditor";
import { clipSound, type SoundClip } from "./montage";
import { soundLabel } from "./names";

// The selected clip's settings: where it is, which part, how loud, its
// fades, its speed (its pitch with it), backwards or not, its effects.

interface Props {
  /** The clip as written, and with its defaults (what's shown). */
  clip: SoundClip;
  shown: SoundClip;
  readOnly: boolean;
  onChange: (next: SoundClip) => void;
}

/** The settings shown: field, label, step. */
const FIELDS: [keyof SoundClip, string, number][] = [
  ["at", "Starts at, s", 0.01],
  ["from", "From, s", 0.01],
  ["to", "To, s", 0.01],
  ["gain", "Gain", 0.05],
  ["fade_in", "Fade in, s", 0.01],
  ["fade_out", "Fade out, s", 0.01],
  ["speed", "Speed (pitch)", 0.05],
];

export function ClipInspector({ clip, shown, readOnly, onChange }: Props) {
  const t = useT();
  const value = (k: keyof SoundClip) => (shown[k] as number | null | undefined) ?? "";
  return (
    <div className="sound-clip-inspector">
      <div className="sound-clip-title">{soundLabel(clipSound(clip))}</div>
      {FIELDS.map(([k, label, step]) => (
        <label key={k}>
          {t(label)}
          <input
            type="number"
            step={step}
            min={0}
            value={value(k)}
            disabled={readOnly}
            onChange={(e) => onChange({ ...clip, [k]: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
        </label>
      ))}
      <label className="sound-clip-check">
        <input type="checkbox" checked={!!clip.reverse} disabled={readOnly} onChange={(e) => onChange({ ...clip, reverse: e.target.checked || undefined })} />
        {t("Backwards")}
      </label>
      <div className="sound-clip-subtitle">{t("Effects")}</div>
      <EffectsEditor effects={clip.effects ?? []} readOnly={readOnly} onChange={(effects) => onChange({ ...clip, effects: effects.length ? effects : undefined })} />
    </div>
  );
}
