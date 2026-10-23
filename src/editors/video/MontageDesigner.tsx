import { useCallback, useEffect, useMemo, useState } from "react";
import { type PropertyDescriptor, ToolbarButton, useT } from "substrate-platform-ui";
import { shapeKind } from "../../data/yogIds.generated";
import { type Described, shapeProperties } from "../../data/shapeGrid";
import { MixEditor } from "../sound/MixEditor";
import type { Mix } from "../sound/montage";
import { MediaList } from "./MediaList";
import { type Montage, PICTURE_CLIP_DEF, type PictureClip, tidy } from "./montage";
import { PictureLanes } from "./PictureLanes";
import type { VideoList } from "./preview";

// A montage, as a video editor lays one out: the mod's videos and pictures
// down the left, the picture tracks beside them, the sound's DAW below;
// Properties shows what was last worked on — a picture clip, the sound —
// else the file (`onProperties(null)`).

/** Pixels a second along the picture tracks. */
const PPS = 60;

interface Props {
  path: string;
  montage: Montage;
  /** The montage with its defaults. */
  shown: Montage;
  media: VideoList;
  /** How long each clip shows (the render's), seconds. */
  lengths: number[];
  shape: Described | null;
  position: number;
  readOnly: boolean;
  onSeek: (t: number) => void;
  onChange: (next: Montage) => void;
  onProperties: (rows: PropertyDescriptor[] | null) => void;
}

/** What was last worked on. */
type Focus = "pictures" | "sound" | null;

const EMPTY_MIX: Mix = { clips: [] };

export function MontageDesigner({ path, montage, shown, media, lengths, shape, position, readOnly, onSeek, onChange, onProperties }: Props) {
  const t = useT();
  const [focus, setFocus] = useState<Focus>(null);
  const [clip, setClip] = useState<number | null>(null);
  const [soundRows, setSoundRows] = useState<PropertyDescriptor[]>([]);
  const onSound = useCallback((rows: PropertyDescriptor[]) => setSoundRows(rows), []);
  const onMix = useCallback((sound: Mix) => onChange({ ...montage, sound }), [montage, onChange]);

  const clipRows = useMemo(() => {
    const c = clip === null ? undefined : montage.clips?.[clip];
    if (!shape || !c || clip === null) return null;
    const desc: Described = { root: { kind: shapeKind.DEF, name: PICTURE_CLIP_DEF }, defs: shape.defs };
    const set = (next: Record<string, unknown>) => onChange({ ...montage, clips: (montage.clips ?? []).map((x, j) => (j === clip ? tidy(next as PictureClip) : x)) });
    const rows = shapeProperties(desc, c as Record<string, unknown>, set, t, shown.clips?.[clip] as Record<string, unknown> | undefined);
    return readOnly ? rows.map((r) => ({ ...r, readOnly: true })) : rows;
  }, [clip, montage, shown, shape, t, readOnly, onChange]);

  useEffect(() => {
    onProperties(focus === "sound" ? soundRows : focus === "pictures" ? clipRows : null);
  }, [focus, soundRows, clipRows, onProperties]);

  return (
    <div className="video-montage">
      <div className="video-montage-pictures" onPointerDownCapture={() => setFocus("pictures")}>
        <MediaList videos={media.own} images={media.images} />
        <PictureLanes
          montage={montage}
          lengths={lengths}
          pps={PPS}
          position={position}
          selected={clip}
          readOnly={readOnly}
          onSelect={setClip}
          onChange={onChange}
          onSeek={onSeek}
        />
      </div>
      <div className="video-montage-sound" onPointerDownCapture={() => setFocus("sound")}>
        {montage.sound ? (
          <MixEditor path={path} mix={montage.sound} shown={shown.sound ?? montage.sound} readOnly={readOnly} onChange={onMix} onProperties={onSound} />
        ) : (
          !readOnly && <ToolbarButton icon="plus" label={t("Add sound")} showLabel onClick={() => onMix(EMPTY_MIX)} />
        )}
      </div>
    </div>
  );
}
