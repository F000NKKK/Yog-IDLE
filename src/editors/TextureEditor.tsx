import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toolbar, ToolbarButton, ToolbarCheck, ToolbarGroup, pushDocumentStep, usePropertyContext, useT, type EditorProps } from "substrate-platform-ui";
import { cli } from "../cli";
import { cropFrame, frameNow, pasteFrame, stillAnimation, type TextureAnimation } from "../content/animation";
import { FrameStrip } from "../content/paint/FrameStrip";
import { PaintCanvas, type PaintPhase } from "../content/paint/PaintCanvas";
import { PaintTools, usePaintState } from "../content/paint/PaintTools";
import { Stroke, decodeImage, getPixel, sameImage, toPngDataUrl, type PixelImage } from "../content/paint/pixels";
import { useDataFile, type DataFormat } from "../data/useDataFile";
import { readObject } from "../data/yogData";
import { shapeProperties, type Described } from "../data/shapeGrid";
import { formatShape } from "./DataEditor";
import { formats } from "../yogFileTypes";
import { reportError } from "../reportError";
import "./TextureEditor.css";

// A `.ytexture`, as an image editor shows a picture: the picture painted in
// the middle (a frame at a time when it animates), the paint tools on the
// left, its frames below, and how the game takes it — atlas, filtering,
// animation timing — in Properties. The picture lives in its `.yres`; the
// CLI reads and writes both (`content_texture`, `content_save_texture`).

/** The file as read: what the CLI's `.ytexture` schema has. */
type TextureFile = Record<string, unknown> & { animation?: unknown };

const FORMAT: DataFormat<TextureFile> = { read: readObject<TextureFile> };

/** What `content_texture` answers. */
interface Texture {
  url: string;
  writable: boolean;
}

/** The editor showing the file's text. */
export const TEXTURE_SOURCE_VIEW = "yog.ytexture.source";

/** How often a playing animation advances, ms. */
const PLAY_TICK_MS = 50;
/** Where the editor's paint settings are remembered. */
const PAINT_KEY = "yog.texture.paint";

export function TextureEditor({ path, content, onChange, readOnly }: EditorProps) {
  const t = useT();
  const { parsed, update } = useDataFile(content, onChange, FORMAT, readOnly);
  const file = parsed?.ok ? parsed.file : null;
  const [id, setId] = useState<string | null>(null);
  const [image, setImage] = useState<PixelImage | null>(null);
  const [writable, setWritable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [animation, setAnimation] = useState<TextureAnimation | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [shape, setShape] = useState<Described | null>(null);
  const { state: paint, set: setPaint, used: usedColor } = usePaintState(PAINT_KEY);
  const stroke = useRef<{ stroke: Stroke; strip: PixelImage } | null>(null);

  // Which texture this file is, and its picture.
  const load = useCallback(async () => {
    try {
      const tid = await cli<string | null>("texture_file_id", { path });
      setId(tid);
      if (!tid) return setError(t("This file isn't in a mod's resources folder."));
      const tex = await cli<Texture>("content_texture", { path, texture: tid });
      setImage(await decodeImage(tex.url));
      setWritable(tex.writable && !readOnly);
      setError(null);
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    }
  }, [path, readOnly, t]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    let live = true;
    void formatShape(formats.texture.ext).then((s) => live && setShape(s));
    return () => {
      live = false;
    };
  }, []);

  // The animation the file describes, resolved for the picture by the CLI.
  const fileAnimation = file?.animation;
  useEffect(() => {
    if (!image) return;
    if (fileAnimation === undefined) return setAnimation(null);
    let live = true;
    void cli<TextureAnimation | null>("texture_animation_resolve", { animation: fileAnimation, width: image.w, height: image.h }).then(
      (a) => live && setAnimation(a),
      () => live && setAnimation(null),
    );
    return () => {
      live = false;
    };
  }, [fileAnimation, image]);

  useEffect(() => {
    if (!playing || !animation) return;
    const start = performance.now();
    const h = window.setInterval(() => setFrame(frameNow(animation, performance.now() - start)), PLAY_TICK_MS);
    return () => window.clearInterval(h);
  }, [playing, animation]);

  const entry = animation ? Math.min(frame, animation.frames.length - 1) : 0;
  const frameIndex = animation?.frames[entry]?.index ?? 0;
  const shown = useMemo(() => (image && animation ? cropFrame(image, animation, frameIndex) : image), [image, animation, frameIndex]);

  /** Writes the picture into its `.yres` (one undo step, the old picture its undo). */
  const savePicture = useCallback(
    async (next: PixelImage, before: PixelImage | null) => {
      if (!id) return;
      const write = async (img: PixelImage) => {
        setImage(img);
        const png = toPngDataUrl(img);
        await cli<string>("content_save_texture", { path, texture: id, png: png.slice(png.indexOf(",") + 1) }).catch((e) => reportError(String(e)));
      };
      await write(next);
      if (before) pushDocumentStep(path, { undo: () => void write(before), redo: () => void write(next) });
    },
    [id, path],
  );

  /** Sets the file's animation (null: still), as the CLI writes it. */
  const saveAnimation = useCallback(
    async (next: TextureAnimation | null, img: PixelImage) => {
      const formatted = next ? await cli<unknown>("texture_animation_format", { animation: next, width: img.w, height: img.h }) : undefined;
      await update((d) => {
        if (formatted === undefined) delete d.animation;
        else d.animation = formatted;
      });
    },
    [update],
  );

  const onPaint = (x: number, y: number, phase: PaintPhase) => {
    if (!image || !writable) return;
    if (phase === "down") {
      if (paint.tool === "picker") {
        const c = shown && getPixel(shown, x, y);
        if (c) setPaint({ color: c, tool: "pencil" });
        return;
      }
      stroke.current = { stroke: new Stroke(shown ?? image, paint, x, y), strip: image };
    } else if (stroke.current) stroke.current.stroke.move(x, y);
    const cur = stroke.current;
    if (!cur) return;
    const painted = animation ? pasteFrame(cur.strip, animation, frameIndex, cur.stroke.image) : cur.stroke.image;
    if (phase !== "up") return setImage(painted);
    stroke.current = null;
    if (sameImage(cur.stroke.image, cur.stroke.base)) return;
    void savePicture(painted, cur.strip);
    if (cur.stroke.settings.tool !== "eraser") usedColor(cur.stroke.settings.color);
  };

  const toggleAnimated = () => {
    if (!image) return;
    void saveAnimation(animation ? null : stillAnimation(image), image);
  };

  const properties = useMemo(() => {
    if (!shape || !file) return [];
    const rows = shapeProperties(shape, file, (next) => void update(() => next as TextureFile), t);
    return readOnly ? rows.map((r) => ({ ...r, readOnly: true })) : rows;
  }, [shape, file, update, readOnly, t]);
  usePropertyContext(path, file ? { objectName: path.split(/[\\/]/).pop(), objectType: t("Texture"), objectKey: path, properties } : null);

  if (!parsed) return null;
  if (!parsed.ok) return <div className="designer-error">{t("This file has a mistake: {error}", { error: parsed.error })}</div>;
  return (
    <div className="texture-editor">
      <Toolbar>
        <ToolbarGroup>
          <ToolbarCheck label="Grid" checked={paint.grid} onChange={(grid) => setPaint({ grid })} />
          <ToolbarCheck label="Animated" checked={!!animation} onChange={toggleAnimated} disabled={!writable} />
          <ToolbarButton icon="refresh" label="Reload the picture" onClick={() => void load()} />
        </ToolbarGroup>
      </Toolbar>
      <div className="texture-editor-body">
        <PaintTools paint={paint} onChange={setPaint} disabled={!writable} />
        <div className="texture-editor-center">
          <PaintCanvas
            className="texture-editor-canvas"
            image={shown}
            grid={paint.grid}
            brushSize={paint.size}
            mirrorX={paint.mirrorX}
            onPaint={onPaint}
            emptyText={error ?? t("Loading…")}
          />
          {image && animation && (
            <FrameStrip
              image={image}
              animation={animation}
              selected={entry}
              onSelect={setFrame}
              playing={playing}
              onPlaying={setPlaying}
              readOnly={!writable}
              onChange={(next, img) => {
                if (img) void savePicture(img, image);
                void saveAnimation(next, img ?? image);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
