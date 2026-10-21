import { useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { iconSource, imagePreview, imageSourcesVersion, subscribeImageSources } from "../../designer/imageSources";
import "./GamePanel.css";

/** Room around the panel, pixels. */
const MARGIN = 24;

/**
 * The content of a designer drawn as the game shows it: `width`×`height`
 * GUI pixels, scaled by the largest whole number that fits the stage (as
 * the game's GUI scale, never below 1: a fraction would draw its pixels
 * uneven); `children` draws at scale `k`.
 * `panel`: on a light GUI window (default), or bare (a dark screen of its
 * own, as the advancements screen).
 */
export function GameStage({ width, height, panel = true, className, children, onBackground }: { width: number; height: number; panel?: boolean; className?: string; children: (k: number) => ReactNode; onBackground?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<[number, number]>([0, 0]);
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => setSize([el.clientWidth, el.clientHeight]);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  const fit = Math.min((size[0] - MARGIN * 2) / Math.max(width, 1), (size[1] - MARGIN * 2) / Math.max(height, 1));
  const k = Math.max(1, Math.floor(fit));
  return (
    <div className={`game-stage${className ? ` ${className}` : ""}`} ref={ref} onPointerDown={(e) => e.target === e.currentTarget && onBackground?.()}>
      {size[0] > 0 && (
        <div className={panel ? "game-panel" : "game-screen"} style={{ width: width * k, height: height * k, padding: panel ? 4 * k : 0 }}>
          <div className="game-panel-inner" style={{ width: width * k, height: height * k, fontSize: 8 * k, "--k": k } as CSSProperties}>
            {children(k)}
          </div>
        </div>
      )}
    </div>
  );
}

/** Re-renders when an icon the IDE draws arrives. */
export function useIcons(): number {
  return useSyncExternalStore(subscribeImageSources, imageSourcesVersion);
}

/** An item's icon (`@item:…`, `@block:…` or an id), 16 GUI pixels at scale `k`; its id's last part while it isn't drawn. */
export function ItemIcon({ path, id, k, title }: { path: string; id: string | undefined; k: number; title?: string }) {
  useIcons();
  const bare = (id ?? "").replace(/^@(?:item|block):/, "");
  const url = bare && !bare.startsWith("@") ? imagePreview(path, iconSource(bare)) : null;
  const style = { width: 16 * k, height: 16 * k };
  if (url) return <img className="game-icon" src={url} alt="" style={style} title={title ?? bare} draggable={false} />;
  return (
    <span className="game-icon is-missing" style={{ ...style, fontSize: 5 * k }} title={title ?? bare}>
      {bare.split(/[:/]/).pop()}
    </span>
  );
}

/** A slot as the game draws one: 18 GUI pixels, sunk, the item inside. */
export function Slot({ k, children, picked, onPick, label, style }: { k: number; children?: ReactNode; picked?: boolean; onPick?: () => void; label?: ReactNode; style?: CSSProperties }) {
  return (
    <button type="button" className={`game-slot${picked ? " is-picked" : ""}`} style={{ width: 18 * k, height: 18 * k, borderWidth: k, ...style }} onClick={onPick}>
      {children}
      {label !== undefined && <span className="game-slot-label">{label}</span>}
    </button>
  );
}
