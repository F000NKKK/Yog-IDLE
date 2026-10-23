import { useEffect, useMemo, useState } from "react";
import { serveMethod } from "../data/yogIds.generated";
import { type EditorProps, Toolbar, ToolbarButton, ToolbarCheck, ToolbarGroup, usePropertyContext, useT } from "substrate-platform-ui";
import { cli } from "../cli";
import { useDataFile, type DataFormat } from "../data/useDataFile";
import { useComplete } from "../data/useComplete";
import { readObject } from "../data/yogData";
import { shapeProperties, type Described } from "../data/shapeGrid";
import { formatShape } from "./DataEditor";
import { formats } from "../yogFileTypes";
import type { ParticleLook } from "./particle/particleSim";
import { type Frames, framesOf } from "./particle/particleView";
import { type Emitter, ParticleViewport } from "./particle/ParticleViewport";
import { EmitterPanel, useEmitter } from "./particle/EmitterPanel";
import "./ParticleEditor.css";

// A `.yparticle`, as a particle designer shows it: the particle sprayed in
// 3D as the game draws it — its pictures, life, motion and blending — with
// every setting in Properties; the preview's emitter (how many, how fast,
// what colour) is the designer's, not the file's.

type ParticleFile = Record<string, unknown>;

const FORMAT: DataFormat<ParticleFile> = { read: readObject<ParticleFile> };

/** What `content_texture` answers. */
interface Texture {
  url: string;
}

/** The editor showing the file's text. */
export const PARTICLE_SOURCE_VIEW = "yog.yparticle.source";

/** A picture at `url`, loaded. */
function image(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(url));
    img.src = url;
  });
}

/** The particle's pictures, from the mod's textures. */
function useFrames(path: string, textures: string[] | undefined): Frames | null {
  const [frames, setFrames] = useState<Frames | null>(null);
  const key = textures?.join("\n") ?? "";
  useEffect(() => {
    if (!key) return;
    let live = true;
    void Promise.all(key.split("\n").map((id) => cli<Texture>(serveMethod.CONTENT_TEXTURE, { path, texture: id }).then((t) => image(t.url)))).then(
      (images) => live && setFrames(framesOf(images)),
      () => live && setFrames(null),
    );
    return () => {
      live = false;
    };
  }, [path, key]);
  return frames;
}

export function ParticleEditor({ path, content, onChange, readOnly }: EditorProps) {
  const t = useT();
  const { parsed, update } = useDataFile(content, onChange, FORMAT, readOnly);
  const file = parsed?.ok ? parsed.file : null;
  const { complete: look, error } = useComplete<ParticleLook>(file, formats.particle.ext);
  const frames = useFrames(path, look?.textures);
  const [shape, setShape] = useState<Described | null>(null);
  const [playing, setPlaying] = useState(true);
  const [night, setNight] = useState(false);
  const [restart, setRestart] = useState(0);
  const [emitter, setEmitter] = useEmitter();
  useEffect(() => {
    let live = true;
    void formatShape(formats.particle.ext).then((s) => live && setShape(s));
    return () => {
      live = false;
    };
  }, []);

  const properties = useMemo(() => {
    if (!shape || !file) return [];
    const rows = shapeProperties(shape, file, (next) => void update(() => next as ParticleFile), t);
    return readOnly ? rows.map((r) => ({ ...r, readOnly: true })) : rows;
  }, [shape, file, update, readOnly, t]);
  usePropertyContext(path, file ? { objectName: path.split(/[\\/]/).pop(), objectType: t("Particle"), objectKey: path, properties } : null);

  if (!parsed) return null;
  if (!parsed.ok) return <div className="designer-error">{t("This file has a mistake: {error}", { error: parsed.error })}</div>;
  return (
    <div className="particle-editor">
      <Toolbar>
        <ToolbarGroup>
          <ToolbarButton icon={playing ? "pause" : "play"} label={playing ? "Pause" : "Play"} onClick={() => setPlaying(!playing)} />
          <ToolbarButton icon="refresh" label="Start over" onClick={() => setRestart(restart + 1)} />
          <ToolbarCheck label="Night" checked={night} onChange={setNight} />
        </ToolbarGroup>
      </Toolbar>
      <div className="particle-editor-body">
        <ParticleViewport look={look} frames={frames} emitter={emitter as Emitter} playing={playing} night={night} restart={restart} />
        <EmitterPanel emitter={emitter} onChange={setEmitter} />
        {error && <div className="particle-editor-error">{error}</div>}
      </div>
    </div>
  );
}
