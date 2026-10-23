import { useState } from "react";
import { useT } from "substrate-platform-ui";
import type { Emitter } from "./ParticleViewport";

// The preview's emitter: how many particles a tick, how fast, what colour —
// the designer's own (remembered here), not the file's.

/** Where the emitter is remembered. */
const KEY = "yog.particle.emitter";
/** Hex's pigment of a staff, a particle a tick, a casting spray's speed. */
const DEFAULT: Emitter = { rate: 2, speed: 0.1, color: 0xb38ef3 };
/** The fields' ranges and steps. */
const RATE = { min: 0, max: 50, step: 0.5 };
const SPEED = { min: 0, max: 2, step: 0.05 };
/** A colour as `#rrggbb`: its digits, base 16. */
const HEX = 16;
const HEX_DIGITS = 6;

function remembered(): Emitter {
  try {
    return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULT;
  }
}

/** The emitter, and setting it (remembered). */
export function useEmitter(): [Emitter, (next: Emitter) => void] {
  const [emitter, set] = useState(remembered);
  const change = (next: Emitter) => {
    set(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Not remembered: the preview still uses it.
    }
  };
  return [emitter, change];
}

export function EmitterPanel({ emitter, onChange }: { emitter: Emitter; onChange: (next: Emitter) => void }) {
  const t = useT();
  const number = (key: "rate" | "speed", range: typeof RATE) => (
    <input type="number" min={range.min} max={range.max} step={range.step} value={emitter[key]} onChange={(e) => onChange({ ...emitter, [key]: Number(e.target.value) })} />
  );
  return (
    <div className="particle-emitter">
      <div className="particle-emitter-title">{t("Emitter (preview only)")}</div>
      <label>
        {t("Particles a tick")}
        {number("rate", RATE)}
      </label>
      <label>
        {t("Speed")}
        {number("speed", SPEED)}
      </label>
      <label>
        {t("Colour")}
        <input
          type="color"
          value={`#${emitter.color.toString(HEX).padStart(HEX_DIGITS, "0")}`}
          onChange={(e) => onChange({ ...emitter, color: parseInt(e.target.value.slice(1), HEX) })}
        />
      </label>
    </div>
  );
}
