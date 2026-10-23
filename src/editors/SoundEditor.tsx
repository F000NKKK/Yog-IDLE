import { useState } from "react";
import { type EditorProps, Toolbar, ToolbarButton, ToolbarGroup, ToolbarLabel, useT } from "substrate-platform-ui";
import { useDataFile, type DataFormat } from "../data/useDataFile";
import { useComplete } from "../data/useComplete";
import { formats } from "../yogFileTypes";
import { MixEditor } from "./sound/MixEditor";
import { MixRow } from "./sound/MixRow";
import type { Mix } from "./sound/montage";
import { readObject } from "../data/yogData";
import { loadSound, play, forgetSounds } from "./sound/audio";
import { GAME_PITCH, GAME_VOLUME, GAME_WEIGHT, soundOf, type Variant, VariantRow } from "./sound/VariantRow";
import "./SoundEditor.css";

// A `.ysound` sound event, as a sound designer shows it: each sound it may
// play — its waveform, played as the game plays it, its volume, pitch and
// weight — and the event played as the game picks it (by weight). A
// sound is the mod's (`@Sounds.x`, its `.yres`) or one the game has.

type SoundFile = Record<string, unknown> & { sounds?: (Variant & { mix?: Mix })[]; subtitle?: string };

const FORMAT: DataFormat<SoundFile> = { read: readObject<SoundFile> };

/** The editor showing the file's text. */
export const SOUND_SOURCE_VIEW = "yog.ysound.source";

/** One of `variants` as the game picks: by weight. */
function pick(variants: Variant[]): Variant | undefined {
  const total = variants.reduce((s, v) => s + (v.weight ?? GAME_WEIGHT), 0);
  let r = Math.random() * total;
  return variants.find((v) => (r -= v.weight ?? GAME_WEIGHT) < 0) ?? variants[variants.length - 1];
}

export function SoundEditor({ path, content, onChange, readOnly }: EditorProps) {
  const t = useT();
  const { parsed, update } = useDataFile(content, onChange, FORMAT, readOnly);
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const file = parsed?.ok ? parsed.file : null;
  const variants = file?.sounds ?? [];
  // With every default (what's played and shown); edits go to the file as written.
  const shown = useComplete<SoundFile>(file, formats.sound.ext).complete?.sounds ?? [];

  const setVariant = (i: number, next: (Variant & { mix?: Mix }) | null) =>
    void update((d) => {
      const list = [...((d.sounds as Variant[] | undefined) ?? [])];
      if (next) list[i] = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== null && v !== undefined)) as Variant;
      else list.splice(i, 1);
      d.sounds = list;
    });

  const playEvent = async () => {
    const v = pick(shown.filter((s) => !s.mix));
    if (!v) return;
    play(await loadSound(path, soundOf(v)), v.volume ?? GAME_VOLUME, v.pitch ?? GAME_PITCH);
  };

  /** A sound added: `@Set.name` the mod's, else a file the game has. */
  const add = () => {
    const s = adding.trim();
    if (!s) return;
    setVariant(variants.length, s.startsWith("@") ? { sound: s } : { file: s });
    setAdding("");
  };

  if (!parsed) return null;
  if (!parsed.ok) return <div className="designer-error">{t("This file has a mistake: {error}", { error: parsed.error })}</div>;
  return (
    <div className="sound-editor">
      <Toolbar>
        <ToolbarGroup>
          <ToolbarButton icon="play" label="Play the event" showLabel onClick={() => void playEvent()} disabled={!variants.length} />
          <ToolbarButton icon="refresh" label="Reload the sounds" onClick={forgetSounds} />
        </ToolbarGroup>
        {file?.subtitle ? <ToolbarLabel>{t("Subtitle: {subtitle}", { subtitle: file.subtitle })}</ToolbarLabel> : null}
      </Toolbar>
      <div className="sound-editor-body">
        {variants.map((v, i) =>
          v.mix ? (
            <MixRow
              key={i}
              path={path}
              mix={shown[i]?.mix ?? v.mix}
              editing={editing === i}
              onEdit={() => setEditing(editing === i ? null : i)}
              onRemove={() => (setVariant(i, null), setEditing(null))}
              readOnly={!!readOnly}
            />
          ) : (
            <VariantRow key={i} path={path} variant={v} readOnly={!!readOnly} onChange={(next) => setVariant(i, next)} onRemove={() => setVariant(i, null)} />
          ),
        )}
        {editing !== null && variants[editing]?.mix && (
          <MixEditor
            path={path}
            mix={variants[editing].mix as Mix}
            shown={shown[editing]?.mix ?? (variants[editing].mix as Mix)}
            readOnly={!!readOnly}
            onChange={(mix) => setVariant(editing, { ...variants[editing], mix })}
          />
        )}
        {!readOnly && (
          <div className="sound-add">
            <input value={adding} placeholder={t("@Sounds.name, or the game's minecraft:dig/sand1")} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
            <button onClick={add}>{t("Add a sound")}</button>
            <button onClick={() => (setVariant(variants.length, { mix: { clips: [] } }), setEditing(variants.length))}>{t("Add a montage")}</button>
          </div>
        )}
      </div>
    </div>
  );
}
