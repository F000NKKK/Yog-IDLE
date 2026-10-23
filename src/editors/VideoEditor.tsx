import { useCallback, useEffect, useMemo, useState } from "react";
import { type EditorProps, type PropertyDescriptor, Toolbar, ToolbarButton, ToolbarGroup, ToolbarLabel, usePropertyContext, useT } from "substrate-platform-ui";
import { useDataFile, type DataFormat } from "../data/useDataFile";
import { useComplete } from "../data/useComplete";
import { readObject } from "../data/yogData";
import { shapeProperties, type Described } from "../data/shapeGrid";
import { formatShape } from "./DataEditor";
import { formats } from "../yogFileTypes";
import { NO_MEDIA, type VideoList, frameSeconds, videoList } from "./video/preview";
import { useRender } from "./video/useRender";
import { VideoPlayer } from "./video/VideoPlayer";
import { MontageDesigner } from "./video/MontageDesigner";
import type { Montage } from "./video/montage";
import "./VideoEditor.css";

// A `.yvideo`, as a video designer shows it: the video played as the game
// will show it — rendered by the CLI as the build renders it, its frames
// decoded as the game decodes them; a montage laid out below it (its
// picture tracks and its sound's DAW). Settings in Properties (a source
// picked from the mod's videos); the file's text a click (or F7) away.

type VideoFile = Record<string, unknown> & { source?: string; montage?: Montage; width?: number; height?: number };

const FORMAT: DataFormat<VideoFile> = { read: readObject<VideoFile> };

/** The editor showing the file's text. */
export const VIDEO_SOURCE_VIEW = "yog.yvideo.source";

/** The fields naming what's shown. */
const SOURCE = "source";
const MONTAGE = "montage";
/** Decimals of the time shown. */
const TIME_DIGITS = 1;
/** Steps of the time slider, seconds. */
const SLIDER_STEP = 0.01;

/** What the completed file says. */
interface Look {
  looping: boolean;
  volume: number;
  montage?: Montage;
}

/** The mod's videos and pictures. */
function useMedia(path: string): VideoList {
  const [media, setMedia] = useState<VideoList>(NO_MEDIA);
  useEffect(() => {
    let live = true;
    void videoList(path).then(
      (v) => live && setMedia(v),
      () => live && setMedia(NO_MEDIA),
    );
    return () => {
      live = false;
    };
  }, [path]);
  return media;
}

/** `file` made a montage: its source the first clip, at the size it's shown. */
function asMontage(file: VideoFile, size: { width: number; height: number } | null): VideoFile {
  const { source, ...rest } = file;
  return { ...rest, width: file.width ?? size?.width, height: file.height ?? size?.height, montage: { clips: source ? [{ video: source }] : [], sound: { clips: [] } } };
}

export function VideoEditor({ path, content, onChange, readOnly }: EditorProps) {
  const t = useT();
  const { parsed, update } = useDataFile(content, onChange, FORMAT, readOnly);
  const file = parsed?.ok ? parsed.file : null;
  const { complete: look } = useComplete<Look>(file, formats.video.ext);
  const media = useMedia(path);
  const { render, frames, sound, busy, error } = useRender(path, file);
  const [shape, setShape] = useState<Described | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [seek, setSeek] = useState<{ to: number } | null>(null);
  const [inner, setInner] = useState<PropertyDescriptor[] | null>(null);
  const onInner = useCallback((rows: PropertyDescriptor[] | null) => setInner(rows), []);
  useEffect(() => {
    let live = true;
    void formatShape(formats.video.ext).then((s) => live && setShape(s));
    return () => {
      live = false;
    };
  }, []);

  const montage = file?.montage;
  const onMontage = useCallback((next: Montage) => void update((f) => ({ ...f, montage: next })), [update]);
  const properties = useMemo(() => {
    if (inner) return inner;
    if (!shape || !file) return [];
    const hidden = montage ? [SOURCE, MONTAGE] : [MONTAGE];
    const rows = shapeProperties(shape, file, (next) => void update(() => next as VideoFile), t, look as unknown as Record<string, unknown> | null)
      .filter((r) => !hidden.some((h) => r.id === h || r.id.startsWith(`${h}.`)))
      .map((r) => (r.id === SOURCE ? { ...r, kind: "enum" as const, options: media.own } : r));
    return readOnly ? rows.map((r) => ({ ...r, readOnly: true })) : rows;
  }, [inner, shape, file, montage, update, readOnly, t, look, media]);
  usePropertyContext(path, file ? { objectName: path.split(/[\\/]/).pop(), objectType: t(montage ? "Montage" : "Video"), objectKey: path, properties } : null);

  if (!parsed) return null;
  if (!parsed.ok) return <div className="designer-error">{t("This file has a mistake: {error}", { error: parsed.error })}</div>;
  const length = render ? render.frames * frameSeconds(render) : 0;
  const go = (to: number) => {
    setSeek({ to });
    setTime(to);
  };
  const toggle = () => {
    if (!playing && time >= length) go(0);
    setPlaying(!playing);
  };
  return (
    <div className={`video-editor${montage ? " montage" : ""}`}>
      <Toolbar>
        <ToolbarGroup>
          <ToolbarButton icon={playing ? "pause" : "play"} label={playing ? "Pause" : "Play"} disabled={!render} onClick={toggle} />
          <ToolbarButton icon="skipBack" label="Start over" disabled={!render} onClick={() => go(0)} />
          <ToolbarLabel>{`${time.toFixed(TIME_DIGITS)} / ${length.toFixed(TIME_DIGITS)} s`}</ToolbarLabel>
          {render && <ToolbarLabel>{`${render.width}×${render.height}`}</ToolbarLabel>}
          {busy && <ToolbarLabel>{t("Rendering…")}</ToolbarLabel>}
          {error && <ToolbarLabel tone="error">{error}</ToolbarLabel>}
        </ToolbarGroup>
        {!montage && !readOnly && (
          <ToolbarGroup>
            <ToolbarButton icon="layers" label="Make a montage" showLabel onClick={() => void update((f) => asMontage(f, render))} />
          </ToolbarGroup>
        )}
      </Toolbar>
      <div className="video-editor-body">
        <VideoPlayer
          render={render}
          frames={frames}
          sound={sound}
          playing={playing}
          looping={look?.looping ?? false}
          volume={look?.volume ?? 1}
          seek={seek}
          onTime={setTime}
          onEnd={() => setPlaying(false)}
        />
      </div>
      <input className="video-editor-time" type="range" min={0} max={length} step={SLIDER_STEP} value={Math.min(time, length)} disabled={!render} onChange={(e) => go(Number(e.target.value))} />
      {montage && (
        <MontageDesigner
          path={path}
          montage={montage}
          shown={look?.montage ?? montage}
          media={media}
          lengths={render?.clips ?? []}
          shape={shape}
          position={time}
          readOnly={!!readOnly}
          onSeek={go}
          onChange={onMontage}
          onProperties={onInner}
        />
      )}
    </div>
  );
}
