import { Icon, useT } from "substrate-platform-ui";
import type { SoundEffect } from "./montage";

// The effects a clip or a whole mix goes through, in order: each with its
// settings, removed, or one more added.

/** A new effect of each kind: an echo a fifth of a second later, a muffle, a thin phone. */
const NEW: Record<SoundEffect["fx"], SoundEffect> = {
  echo: { fx: "echo", delay: 0.2, decay: 0.4 },
  low_pass: { fx: "low_pass", hz: 800 },
  high_pass: { fx: "high_pass", hz: 2000 },
};
const LABEL: Record<SoundEffect["fx"], string> = { echo: "Echo", low_pass: "Low pass", high_pass: "High pass" };

interface Props {
  effects: SoundEffect[];
  readOnly: boolean;
  onChange: (next: SoundEffect[]) => void;
}

export function EffectsEditor({ effects, readOnly, onChange }: Props) {
  const t = useT();
  const set = (i: number, next: SoundEffect | null) => onChange(next ? effects.map((e, j) => (j === i ? next : e)) : effects.filter((_, j) => j !== i));
  const field = (i: number, e: SoundEffect, key: string, label: string, step: number) => (
    <label key={key}>
      {t(label)}
      <input type="number" step={step} min={0} value={(e as Record<string, number | string>)[key]} disabled={readOnly} onChange={(ev) => set(i, { ...e, [key]: Number(ev.target.value) } as SoundEffect)} />
    </label>
  );
  return (
    <div className="sound-effects">
      {effects.map((e, i) => (
        <div className="sound-effect" key={i}>
          <span className="sound-effect-name">{t(LABEL[e.fx])}</span>
          {e.fx === "echo" ? [field(i, e, "delay", "Delay, s", 0.05), field(i, e, "decay", "Decay", 0.05)] : field(i, e, "hz", "Hz", 50)}
          <button onClick={() => set(i, null)} disabled={readOnly} title={t("Remove")}>
            <Icon name="close" />
          </button>
        </div>
      ))}
      {!readOnly && (
        <div className="sound-effect-add">
          {(Object.keys(NEW) as SoundEffect["fx"][]).map((fx) => (
            <button key={fx} onClick={() => onChange([...effects, NEW[fx]])}>
              + {t(LABEL[fx])}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
