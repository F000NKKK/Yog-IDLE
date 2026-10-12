import { useState } from "react";
import { SearchField, beginItemDrag, useT } from "substrate-platform-ui";
import { TOOLBOX_MIME, useActiveDesigner } from "../designer/activeDesigner";
import { KIND_INFO, KINDS, type KindInfo } from "../designer/yui";
import "./Toolbox.css";

const GROUPS: KindInfo["group"][] = ["Containers", "Common Controls", "Minecraft"];

/** A small glyph per widget kind, drawn in the item's text color. */
const GLYPHS: Record<string, string> = {
  Canvas: "▣",
  Column: "☰",
  Row: "⫴",
  Label: "A",
  Button: "▭",
  Spacer: "↔",
  ItemSlot: "◆",
  InvSlot: "▦",
  Image: "▨",
};

/**
 * Visual Studio's Toolbox: the widget kinds the screen designer can add,
 * grouped, searchable. Drag one onto the design surface, or double-click it
 * (or press Enter) to add it where the selection is.
 */
export function Toolbox() {
  const t = useT();
  const designer = useActiveDesigner();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const needle = query.trim().toLowerCase();
  const kinds = KINDS.filter((k) => k !== "Screen").map((k) => KIND_INFO[k]);

  const add = (info: KindInfo) => {
    if (!designer) return;
    designer.addWidget(info.kind);
    designer.focus();
  };

  return (
    <div className="toolbox">
      <SearchField className="toolbox-search" value={query} onValueChange={setQuery} placeholder={t("Search Toolbox")} />
      {!designer && <p className="toolbox-hint">{t("Open a .yui screen in the designer to add widgets to it.")}</p>}
      <div className="toolbox-list" role="list">
        {GROUPS.map((group) => {
          const shown = kinds.filter((k) => k.group === group && (!needle || t(k.label).toLowerCase().includes(needle) || k.kind.toLowerCase().includes(needle)));
          if (shown.length === 0) return null;
          const open = needle !== "" || !collapsed.has(group);
          return (
            <div key={group} className="toolbox-group">
              <button
                type="button"
                className="toolbox-group-header"
                aria-expanded={open}
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(group)) next.delete(group);
                    else next.add(group);
                    return next;
                  })
                }
              >
                <span className="toolbox-chevron">{open ? "▾" : "▸"}</span>
                {t(group)}
              </button>
              {open &&
                shown.map((info) => (
                  <div
                    key={info.kind}
                    role="listitem"
                    tabIndex={0}
                    className={`toolbox-item${designer ? "" : " disabled"}`}
                    title={t(info.description)}
                    onPointerDown={(e) => {
                      if (designer) beginItemDrag(e, { type: TOOLBOX_MIME, data: info.kind, label: t(info.label) });
                    }}
                    onDoubleClick={() => add(info)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") add(info);
                    }}
                  >
                    <span className="toolbox-glyph">{GLYPHS[info.kind] ?? "•"}</span>
                    {t(info.label)}
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
