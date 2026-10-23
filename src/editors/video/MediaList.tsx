import { Icon, useT } from "substrate-platform-ui";
import { soundLabel } from "../sound/names";
import { MEDIA, MEDIA_DRAG } from "./PictureLanes";

// The mod's videos and pictures, down the left of the picture tracks:
// one dragged onto a track becomes a clip there.

interface Props {
  videos: string[];
  images: string[];
}

/** One medium, dragged as `<kind>\n<reference>`. */
function Item({ kind, media }: { kind: string; media: string }) {
  return (
    <div className="video-media" draggable onDragStart={(e) => e.dataTransfer.setData(MEDIA_DRAG, `${kind}\n${media}`)} title={media}>
      <Icon name={kind === MEDIA.video ? "yogVideo" : "yogTexture"} size={12} />
      <span>{soundLabel(media)}</span>
    </div>
  );
}

export function MediaList({ videos, images }: Props) {
  const t = useT();
  return (
    <div className="video-media-list">
      <div className="video-media-title">{t("Videos")}</div>
      {videos.map((v) => (
        <Item key={v} kind={MEDIA.video} media={v} />
      ))}
      <div className="video-media-title">{t("Pictures")}</div>
      {images.map((i) => (
        <Item key={i} kind={MEDIA.image} media={i} />
      ))}
    </div>
  );
}
