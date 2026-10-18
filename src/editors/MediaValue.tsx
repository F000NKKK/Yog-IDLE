import { useEffect, useRef, useState } from "react";
import { Icon, useT } from "substrate-platform-ui";
import { sep, typed } from "../data/yogIds.generated";

/** What a `.yres` media value starts with: `@bytes:<base64>`. */
const BYTES = `${sep.TYPED}${typed.BYTES}${sep.NAMESPACE}`;

/** The picture formats an image entry can hold (as the CLI reads them, `yog_media::image::EXTENSIONS`). */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tga"];

/** How many bytes a base64 text holds. */
const decodedSize = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

/** `1.2 KB`. */
function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A `.yres` media entry's value, shown as what it is: a picture (thumbnail,
 * its size in pixels and bytes), a sound (a play button), a file (its size)
 * — not its base64.
 */
export function MediaValue({ type, value }: { type: "image" | "sound" | "file"; value: string }) {
  const t = useT();
  const b64 = value.startsWith(BYTES) ? value.slice(BYTES.length) : null;
  const [dims, setDims] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  if (b64 === null) return <span className="yres-value yres-na">{t("no bytes")}</span>;
  const size = sizeText(decodedSize(b64));
  if (type === "image") {
    // The webview reads the picture's own format whatever the type says.
    const src = `data:image/png;base64,${b64}`;
    return (
      <span className="yres-value">
        <img className="yres-thumb" src={src} alt="" draggable={false} onLoad={(e) => setDims(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)} />
        <span className="yres-mono">{dims ? `${dims} · ${size}` : size}</span>
      </span>
    );
  }
  if (type === "sound") {
    const toggle = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (playing) {
        audio.current?.pause();
        setPlaying(false);
        return;
      }
      audio.current = new Audio(`data:audio/ogg;base64,${b64}`);
      audio.current.onended = () => setPlaying(false);
      void audio.current.play().then(
        () => setPlaying(true),
        () => setPlaying(false),
      );
    };
    return (
      <span className="yres-value">
        <button type="button" className="yres-play" title={playing ? t("Stop") : t("Play")} onClick={toggle} onDoubleClick={(e) => e.stopPropagation()}>
          <Icon name={playing ? "stop" : "play"} size={12} />
        </button>
        <span className="yres-mono">{size}</span>
      </span>
    );
  }
  return (
    <span className="yres-value">
      <Icon name="file" size={13} />
      <span className="yres-mono">{size}</span>
    </span>
  );
}
