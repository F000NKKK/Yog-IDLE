import { useEffect, useMemo, useState } from "react";
import { type EditorProps, Toolbar, ToolbarButton, ToolbarGroup, ToolbarLabel, usePropertyContext, useT } from "substrate-platform-ui";
import { useDataFile, type DataFormat } from "../data/useDataFile";
import { useComplete } from "../data/useComplete";
import { readObject } from "../data/yogData";
import { shapeProperties, type Described } from "../data/shapeGrid";
import { formatShape } from "./DataEditor";
import { formats } from "../yogFileTypes";
import { frameSeconds, videoList } from "./video/preview";
import { useRender } from "./video/useRender";
import { VideoPlayer } from "./video/VideoPlayer";
import "./VideoEditor.css";

// A `.yvideo`, as a video designer shows it: the video played as the game
// will show it — rendered by the CLI as the build renders it, its frames
// decoded as the game decodes them — with every setting in Properties
// (its source one of the mod's videos); the file's text a click (or F7)
// away.

type VideoFile = Record<string, unknown>;

const FORMAT: DataFormat<VideoFile> = { read: readObject<VideoFile> };

/** The editor showing the file's text. */
export const VIDEO_SOURCE_VIEW = "yog.yvideo.source";

/** The field naming the video shown. */
const SOURCE = "source";
/** Decimals of the time shown. */
const TIME_DIGITS = 1;
/** Steps of the time slider, seconds. */
const SLIDER_STEP = 0.01;

/** What the completed file says of playing. */
interface Look {
  looping: boolean;
  volume: number;
}

/** The mod's videos, for the source picker. */
function useVideos(path: string): string[] {
  const [videos, setVideos] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void videoList(path).then(
      (v) => live && setVideos(v),
      () => live && setVideos([]),
    );
    return () => {
      live = false;
    };
  }, [path]);
  return videos;
}

export function VideoEditor({ path, content, onChange, readOnly }: EditorProps) {
  const t = useT();
  const { parsed, update } = useDataFile(content, onChange, FORMAT, readOnly);
  const file = parsed?.ok ? parsed.file : null;
  const { complete: look } = useComplete<Look>(file, formats.video.ext);
  const videos = useVideos(path);
  const { render, frames, sound, busy, error } = useRender(path, file);
  const [shape, setShape] = useState<Described | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [seek, setSeek] = useState<{ to: number } | null>(null);
  useEffect(() => {
    let live = true;
    void formatShape(formats.video.ext).then((s) => live && setShape(s));
    return () => {
      live = false;
    };
  }, []);

  const properties = useMemo(() => {
    if (!shape || !file) return [];
    const rows = shapeProperties(shape, file, (next) => void update(() => next as VideoFile), t, look as unknown as Record<string, unknown> | null).map((r) =>
      r.id === SOURCE ? { ...r, kind: "enum" as const, options: videos } : r,
    );
    return readOnly ? rows.map((r) => ({ ...r, readOnly: true })) : rows;
  }, [shape, file, update, readOnly, t, look, videos]);
  usePropertyContext(path, file ? { objectName: path.split(/[\\/]/).pop(), objectType: t("Video"), objectKey: path, properties } : null);

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
    <div className="video-editor">
      <Toolbar>
        <ToolbarGroup>
          <ToolbarButton icon={playing ? "pause" : "play"} label={playing ? "Pause" : "Play"} disabled={!render} onClick={toggle} />
          <ToolbarButton icon="skipBack" label="Start over" disabled={!render} onClick={() => go(0)} />
          <ToolbarLabel>{`${time.toFixed(TIME_DIGITS)} / ${length.toFixed(TIME_DIGITS)} s`}</ToolbarLabel>
          {render && <ToolbarLabel>{`${render.width}×${render.height}`}</ToolbarLabel>}
          {busy && <ToolbarLabel>{t("Rendering…")}</ToolbarLabel>}
          {error && <ToolbarLabel tone="error">{error}</ToolbarLabel>}
        </ToolbarGroup>
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
      <input
        className="video-editor-time"
        type="range"
        min={0}
        max={length}
        step={SLIDER_STEP}
        value={Math.min(time, length)}
        disabled={!render}
        onChange={(e) => go(Number(e.target.value))}
      />
    </div>
  );
}
