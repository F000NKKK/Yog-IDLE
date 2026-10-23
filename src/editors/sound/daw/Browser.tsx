import { useEffect, useMemo, useState } from "react";
import { Icon, useT } from "substrate-platform-ui";
import { serveMethod } from "../../../data/yogIds.generated";
import { cli } from "../../../cli";
import { loadSound, play } from "../audio";
import { soundLabel, soundName } from "../names";

// The browser, down the left as a music program has it: the mod's sounds
// and the game's, the game's in their folders; one clicked is heard, one
// dragged onto a track becomes a clip there.

/** What a dragged sound carries. */
export const SOUND_DRAG = "application/x-yog-sound";

/** What `sound_list` answers. */
interface SoundList {
  own: string[];
  game: string[];
}

/** The game's sounds by their first folder: `dig` → `minecraft:dig/sand1`… */
function folders(game: string[]): [string, string[]][] {
  const by = new Map<string, string[]>();
  for (const s of game) {
    const path = s.slice(s.indexOf(":") + 1);
    const folder = path.includes("/") ? path.slice(0, path.indexOf("/")) : "";
    by.set(folder, [...(by.get(folder) ?? []), s]);
  }
  return [...by].sort(([a], [b]) => a.localeCompare(b));
}

export function Browser({ path }: { path: string }) {
  const t = useT();
  const [list, setList] = useState<SoundList>({ own: [], game: [] });
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set(["own/Sounds"]));
  useEffect(() => {
    let live = true;
    cli<SoundList>(serveMethod.SOUND_LIST, { path }).then(
      (l) => live && setList(l),
      () => live && setList({ own: [], game: [] }),
    );
    return () => {
      live = false;
    };
  }, [path]);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => folders(list.game.filter((s) => !q || s.toLowerCase().includes(q))), [list.game, q]);
  const own = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const s of list.own.filter((x) => !q || x.toLowerCase().includes(q))) {
      const set = soundName(s).set ?? "";
      by.set(set, [...(by.get(set) ?? []), s]);
    }
    return [...by];
  }, [list.own, q]);
  const toggle = (key: string) => setOpen((o) => new Set(o.has(key) ? [...o].filter((k) => k !== key) : [...o, key]));
  const hear = (s: string) => void loadSound(path, s).then((b) => play(b, 1, 1));

  const item = (s: string) => (
    <div key={s} className="daw-browser-item" draggable onDragStart={(e) => e.dataTransfer.setData(SOUND_DRAG, s)} onClick={() => hear(s)} title={t("Click to hear, drag onto a track")}>
      <Icon name="play" />
      <span>{soundLabel(s)}</span>
    </div>
  );
  const folder = (key: string, label: string, items: string[]) => (
    <div key={key}>
      <div className="daw-browser-folder" onClick={() => toggle(key)}>
        <Icon name={open.has(key) || q ? "folderOpen" : "folder"} />
        <span>{label}</span>
        <span className="daw-browser-count">{items.length}</span>
      </div>
      {(open.has(key) || q) && <div className="daw-browser-items">{items.map(item)}</div>}
    </div>
  );
  return (
    <div className="daw-browser">
      <input className="daw-browser-search" value={query} placeholder={t("Search sounds")} onChange={(e) => setQuery(e.target.value)} />
      <div className="daw-browser-tree">
        <div className="daw-browser-section">{t("The mod's sounds")}</div>
        {own.map(([set, items]) => folder(`own/${set}`, set, items))}
        <div className="daw-browser-section">{t("The game's sounds")}</div>
        {groups.map(([name, items]) => folder(`game/${name}`, name || "—", items))}
      </div>
    </div>
  );
}
