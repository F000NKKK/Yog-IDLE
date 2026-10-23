import { useEffect, useRef, useState } from "react";
import { serveMethod } from "../../data/yogIds.generated";
import { cli } from "../../toolchain/cli";
import { useT } from "substrate-platform-ui";

/** A `.yui` whose root is a book page component (`<Component … book_page="…">`). */
export function isBookPage(text: string): boolean {
  return /<Component\b[^>]*\bbook_page\s*=/.test(text);
}

interface Rendered {
  image: string | null;
  scale: number;
  error: string | null;
}

/** The book's GUI size the page is drawn in (a 1080p screen at GUI 4). */
const SCREEN_W = 480;
const SCREEN_H = 270;
const SCALE = 3;

/**
 * A book page component drawn by the book itself (yog-book's renderer, as
 * in the game): one page of the kind, its fields their defaults or
 * samples. Edited in XAML; this shows what the book will show.
 */
export function BookPagePreview({ path, content }: { path: string; content: string }) {
  const t = useT();
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    const timer = setTimeout(() => {
      cli<Rendered>(serveMethod.BOOK_PAGE_PREVIEW, {
        args: { path, text: content, screenW: SCREEN_W, screenH: SCREEN_H, scale: SCALE, action: null, locale: null },
      })
        .then((r) => n === seq.current && setRendered(r))
        .catch((e) => n === seq.current && setRendered({ image: null, scale: SCALE, error: String(e) }));
    }, 150);
    return () => clearTimeout(timer);
  }, [path, content]);
  useEffect(() => () => void cli(serveMethod.BOOK_DESIGNER_CLOSE, { path }).catch(() => {}), [path]);

  return (
    <div className="book-page-preview">
      <div className="book-page-preview-bar">{t("Book page — as the book shows it, with sample values. Edit it in XAML.")}</div>
      <div className="book-page-preview-stage">
        {rendered?.image && <img src={rendered.image} alt="" draggable={false} />}
      </div>
      {rendered?.error && <div className="book-page-preview-error">{rendered.error}</div>}
    </div>
  );
}
