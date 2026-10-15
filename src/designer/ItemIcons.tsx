import { useSyncExternalStore } from "react";
import { useT } from "substrate-platform-ui";
import { imagePreview, imageSourcesVersion, subscribeImageSources } from "./imageSources";
import "./ItemIcons.css";

/** Items as their icons (`item:<id>` previews), each named in its tooltip; `onPick` makes them buttons. */
export function ItemIcons({ path, items, onPick, empty }: { path: string; items: readonly string[]; onPick?: (id: string) => void; empty?: string }) {
  const t = useT();
  useSyncExternalStore(subscribeImageSources, imageSourcesVersion);
  if (!items.length) return <div className="item-icons-empty">{empty ?? t("Nothing")}</div>;
  return (
    <div className="item-icons">
      {[...new Set(items)].map((id) => {
        const src = imagePreview(path, `item:${id}`);
        const icon = src ? <img src={src} alt="" draggable={false} /> : <span>{id.split(":").pop()?.slice(0, 2)}</span>;
        return onPick ? (
          <button key={id} type="button" className="item-icons-cell" title={t("{id} — use it alone", { id })} onClick={() => onPick(id)}>
            {icon}
          </button>
        ) : (
          <span key={id} className="item-icons-cell" title={id}>
            {icon}
          </span>
        );
      })}
    </div>
  );
}

/** One item, large, with its id — Properties' header for what's selected. */
export function ItemHeader({ path, item, caption }: { path: string; item: string | null; caption: string }) {
  useSyncExternalStore(subscribeImageSources, imageSourcesVersion);
  const src = item ? imagePreview(path, `item:${item}`) : null;
  return (
    <div className="item-header">
      <span className="item-header-icon">{src && <img src={src} alt="" draggable={false} />}</span>
      <span className="item-header-text">
        <span className="item-header-caption">{caption}</span>
        <span className="item-header-id">{item ?? "—"}</span>
      </span>
    </div>
  );
}
