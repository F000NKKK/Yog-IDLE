import { useState } from "react";
import { SearchField, beginItemDrag, useT } from "substrate-platform-ui";
import { TOOLBOX_MIME, useActiveDesigner } from "../designer/activeDesigner";
import { useComponents } from "../designer/components";
import { KIND_INFO, KINDS } from "../designer/yui";
import { useProject } from "../ProjectContext";
import "./Toolbox.css";

const GROUPS = ["Containers", "Common Controls", "Minecraft"] as const;

/** What a Toolbox entry adds: a built-in widget kind or one of the mod's components. */
interface Entry {
  kind: string;
  label: string;
  description: string;
  glyph: string;
}

interface Group {
  key: string;
  title: string;
  entries: Entry[];
  /** Shown under the header (the designer library's state). */
  note?: string;
  /** Shown when it has no entries. */
  empty?: string;
}

/** A small glyph per widget kind, drawn in the item's text color. */
const GLYPHS: Record<string, string> = {
  Canvas: "▣",
  Column: "☰",
  Row: "⫴",
  ScrollView: "⇕",
  Label: "A",
  Button: "▭",
  TextBox: "⌶",
  Spacer: "↔",
  ItemSlot: "◆",
  InvSlot: "▦",
  Image: "▨",
};

/**
 * Visual Studio's Toolbox: the widget kinds the screen designer can add,
 * grouped, searchable, and the open mod's own components (docs/yui.md,
 * "Components") — listed from their `.yui` files, kept current as they're
 * added, renamed or removed. Drag one onto the design surface, or
 * double-click it (or press Enter) to add it where the selection is.
 */
export function Toolbox() {
  const t = useT();
  const designer = useActiveDesigner();
  const { project } = useProject();
  const components = useComponents(designer?.path ?? project?.root);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const needle = query.trim().toLowerCase();

  const groups: Group[] = GROUPS.map((group) => ({
    key: group,
    title: t(group),
    entries: KINDS.filter((k) => k !== "Screen" && KIND_INFO[k].group === group).map((k) => ({
      kind: k,
      label: t(KIND_INFO[k].label),
      description: t(KIND_INFO[k].description),
      glyph: GLYPHS[k] ?? "•",
    })),
  }));
  if (components) {
    // A component can't hold itself: not offered while its own .yui is open.
    const editing = designer?.doc.root.kind === "Component" ? designer.doc.root.attrs.name : undefined;
    const building = components.compiled.length > 0 && components.status === "building";
    const failed = components.compiled.length > 0 && components.status === "failed";
    groups.push({
      key: "components",
      title: t("{name} Components", { name: components.modName }),
      entries: components.components
        .filter((c) => c.name !== editing)
        .map((c) => ({ kind: c.name, label: c.name, description: c.doc || c.name, glyph: "◇" })),
      note: building ? t("Building designer library…") : failed ? t("The designer library failed to build: {error}", { error: components.error ?? "" }) : undefined,
      empty: t("No components yet — Add > New Item > Component (.yui)."),
    });
  }

  const add = (kind: string) => {
    if (!designer) return;
    designer.addWidget(kind);
    designer.focus();
  };

  return (
    <div className="toolbox">
      <SearchField className="toolbox-search" value={query} onValueChange={setQuery} placeholder={t("Search Toolbox")} />
      {!designer && <p className="toolbox-hint">{t("Open a .yui screen in the designer to add widgets to it.")}</p>}
      <div className="toolbox-list" role="list">
        {groups.map((group) => {
          const shown = group.entries.filter((e) => !needle || e.label.toLowerCase().includes(needle) || e.kind.toLowerCase().includes(needle));
          if (shown.length === 0 && (needle || !group.empty)) return null;
          const open = needle !== "" || !collapsed.has(group.key);
          return (
            <div key={group.key} className="toolbox-group">
              <button
                type="button"
                className="toolbox-group-header"
                aria-expanded={open}
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.key)) next.delete(group.key);
                    else next.add(group.key);
                    return next;
                  })
                }
              >
                <span className="toolbox-chevron">{open ? "▾" : "▸"}</span>
                {group.title}
              </button>
              {open && group.note && <p className="toolbox-note" title={group.note}>{group.note}</p>}
              {open && shown.length === 0 && <p className="toolbox-note">{group.empty}</p>}
              {open &&
                shown.map((entry) => (
                  <div
                    key={entry.kind}
                    role="listitem"
                    tabIndex={0}
                    className={`toolbox-item${designer ? "" : " disabled"}`}
                    title={entry.description}
                    onPointerDown={(e) => {
                      if (designer) beginItemDrag(e, { type: TOOLBOX_MIME, data: entry.kind, label: entry.label });
                    }}
                    onDoubleClick={() => add(entry.kind)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") add(entry.kind);
                    }}
                  >
                    <span className="toolbox-glyph">{entry.glyph}</span>
                    {entry.label}
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
