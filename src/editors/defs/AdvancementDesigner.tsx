import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon, IconButton, SelectField, TextField, ToolbarCheck, ToolbarGroup, ToolbarSelect, useT, type PropertyDescriptor } from "substrate-platform-ui";
import { qualify, refId, refProblem, refSuggestions, useContentDefs, useContentRefs, type RefChoices } from "../../data/contentRefs";
import { designText, useDesignResources } from "../../lang/designResources";
import { openFile } from "../../fileOpenBus";
import { modRootOf } from "../../paths";
import { inspectorRows, refMessage } from "../inspector";
import { asList, CRITERIA, criterionKind, FRAMES, layoutTree, rootOf, tabOf, type AdvNode, type Criterion } from "./defModel";
import { DefLayout, type DefProps } from "./DefLayout";
import { GameStage, ItemIcon, useIcons } from "./GamePanel";
import { imageNatural } from "../../designer/imageSources";
import "./defs.css";

const FRAME_LABELS: Record<(typeof FRAMES)[number], string> = { task: "Task", goal: "Goal", challenge: "Challenge" };
const CRITERION_LABELS: Record<Criterion, string> = { granted: "Granted by the Mod", has_item: "Has an Item", used_item: "Used an Item" };

// The game's advancements screen, GUI pixels (`AdvancementsScreen`,
// `AdvancementTab`, `AdvancementWidget`).
/** The window and where its tab's view is inside it. */
const WINDOW = { w: 252, h: 140 };
const VIEW = { x: 9, y: 18, w: 234, h: 113 };
/** Where the tab's title is written, and its colour. */
const TITLE_AT = { x: 8, y: 6 };
/** A tree position's step: column, row. */
const STEP = { x: 28, y: 27 };
/** A frame's side and where it and its icon sit in a widget. */
const FRAME = 26;
const FRAME_DX = 3;
const ICON_AT = { x: 8, y: 5 };
/** A background tile's side. */
const TILE = 16;
/** Where a frame's connector leaves it, and how far it runs before turning. */
const CONNECT = { mid: 13, out: FRAME + 4 };
/** The sprites (`yog-gfx/assets/sprites.ydata`). */
const WINDOW_SPRITE = "sprite:advancement_window";
const frameSprite = (frame: string, obtained: boolean) => `sprite:advancement/${frame}${obtained ? "_obtained" : ""}`;

/** `minecraft:textures/block/calcite.png` → the texture id `minecraft:block/calcite`. */
const textureId = (s: string) => s.replace(/^([a-z0-9_.-]+:)?textures\//, "$1").replace(/\.png$/, "");

interface Shown extends AdvNode {
  file: string | null;
  value: Record<string, unknown>;
}

/**
 * An advancement as the game's advancements screen shows its tab: every
 * advancement of the mod under the same root, laid out as a tree with its
 * frame and icon, the root's background behind; this one picked. A click
 * on another opens its file; hovering one shows its title and description.
 */
export function AdvancementDesigner({ path, file, update, readOnly, kindLabel }: DefProps) {
  const t = useT();
  useIcons();
  useDesignResources(modRootOf(path));
  const defs = useContentDefs(path, "advancement");
  const advancements = useContentRefs(path, "advancement");
  const items = useContentRefs(path, "item");
  const [strings, setStrings] = useState<string[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    invoke<string[]>("content_strings", { path }).then((s) => setStrings(s ?? []), () => setStrings([]));
  }, [path]);

  const ns = defs[0]?.id.split(":")[0] ?? advancements.own[0]?.id.split(":")[0] ?? "minecraft";
  const thisId = qualify(file.id ?? path.split(/[\\/]/).pop()!.replace(/\.ydef$/, ""), ns);
  const parentOf = (v: Record<string, unknown>) => (typeof v.parent === "string" ? refId(v.parent, "advancement") : null);

  // The mod's advancements, this one as it's being edited; a parent outside the mod drawn too.
  const nodes = useMemo<Shown[]>(() => {
    const current = defs.findIndex((d) => d.file === path);
    const selected = current >= 0 ? current : defs.findIndex((d) => d.id === thisId);
    const out: Shown[] = defs.map((d, i) => {
      const active = i === selected;
      const value = active ? file : d.value;
      return { id: active ? thisId : d.id, parent: parentOf(value), file: active ? path : d.file, value };
    });
    if (selected < 0) out.push({ id: thisId, parent: parentOf(file), file: path, value: file });
    for (const n of [...out]) if (n.parent && !out.some((o) => o.id === n.parent)) out.push({ id: n.parent, parent: null, file: null, value: {} });
    return out;
  }, [defs, file, path, thisId]);
  const root = rootOf(nodes, thisId);
  const tab = tabOf(nodes, root) as Shown[];
  const at = layoutTree(tab);
  // Each widget where the game puts it, and the tab's extent (`AdvancementTab.addWidget`).
  const place = new Map([...at].map(([id, p]) => [id, { x: Math.floor(p.x * STEP.x), y: Math.floor(p.y * STEP.y) }]));
  const spots = [...place.values()];
  const minX = Math.min(...spots.map((p) => p.x), 0);
  const maxX = Math.max(...spots.map((p) => p.x + STEP.x), 0);
  const minY = Math.min(...spots.map((p) => p.y), 0);
  const maxY = Math.max(...spots.map((p) => p.y + STEP.y), 0);
  // The view's first position: the tree centred (`AdvancementTab.drawContents`), then dragged within its extent.
  const centre = { x: Math.trunc(VIEW.w / 2 - (maxX + minX) / 2), y: Math.trunc(Math.floor(VIEW.h / 2) - (maxY + minY) / 2) };
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const clampScroll = (v: number, extent: number, view: number) => (extent > view ? Math.min(0, Math.max(-(extent - view), v)) : v);
  const scroll = {
    x: maxX - minX > VIEW.w ? clampScroll(centre.x + drag.x, maxX, VIEW.w) : centre.x,
    y: maxY - minY > VIEW.h ? clampScroll(centre.y + drag.y, maxY, VIEW.h) : centre.y,
  };
  const rootNode = tab.find((n) => n.id === root);

  // The root's background, tiled 16 GUI pixels a block.
  const [background, setBackground] = useState<string | null>(null);
  const bg = typeof rootNode?.value.background === "string" ? rootNode.value.background : null;
  useEffect(() => {
    if (!bg) return setBackground(null);
    let live = true;
    invoke<{ url: string }>("content_texture", { path, texture: textureId(bg) }).then(
      (x) => live && setBackground(x.url),
      () => live && setBackground(null),
    );
    return () => {
      live = false;
    };
  }, [bg, path]);

  const text = (v: unknown) => (typeof v === "string" ? designText(v) : "");

  // ── Properties ────────────────────────────────────────────────────────────

  const properties = useMemo<PropertyDescriptor[]>(() => {
    const { text: row, ref, choice, flag } = inspectorRows(t, readOnly, path);
    const c = t("Advancement");
    const out: PropertyDescriptor[] = [
      row("id", t("Id"), c, file.id, (v) => update((d) => void (d.id = v)), { description: t("Its id: a path of the mod's (lore/cardamom1).") }),
      ref("parent", t("Parent"), c, file.parent as string | undefined, "advancement", { ...advancements, own: advancements.own.filter((o) => o.id !== thisId) }, (v) => update((d) => void (d.parent = v)), {
        description: t("The advancement it hangs under; none: the root of a tab of its own."),
      }),
      ref("icon", t("Icon"), c, file.icon as string | undefined, "item", items, (v) => update((d) => void (d.icon = v)), { description: t("The item drawn in its frame.") }),
      row("title", t("Title"), c, file.title as string | undefined, (v) => update((d) => void (d.title = v)), { suggestions: strings, description: t("A .yres text (@Lang.…), a translation key or words.") }),
      row("description", t("Description"), c, file.description as string | undefined, (v) => update((d) => void (d.description = v)), { suggestions: strings }),
      choice("frame", t("Frame"), c, file.frame as string | undefined, FRAMES, (v) => update((d) => void (d.frame = v === "task" ? undefined : v)), {
        optionLabel: (o) => (o ? t(FRAME_LABELS[o as keyof typeof FRAME_LABELS]) : ""),
        description: t("How its frame looks: a task (square), a goal (rounded) or a challenge (diamond)."),
      }),
      flag("hidden", t("Hidden"), c, file.hidden as boolean | undefined, false, (v) => update((d) => void (d.hidden = v)), { description: t("Not shown before it's had.") }),
    ];
    if (!file.parent)
      out.push(
        row("background", t("Background"), c, file.background as string | undefined, (v) => update((d) => void (d.background = v)), {
          description: t("A root's background texture, tiled behind its tab (minecraft:textures/block/calcite.png)."),
        }),
      );
    out.push({
      id: "criteria",
      name: "",
      category: t("Criteria"),
      value: null,
      kind: "custom",
      description: t("What earns it — every one of them."),
      render: () => <CriteriaEditor criteria={asList<Record<string, unknown>>(file.criteria)} items={items} readOnly={readOnly} onChange={(c) => update((d) => void (d.criteria = c))} />,
    });
    return out;
  }, [file, readOnly, t, path, update, advancements, items, strings, thisId]);

  const frame = (v: Record<string, unknown>) => (FRAMES.includes(v.frame as never) ? (v.frame as string) : "task");
  const shownTitle = text(rootNode?.value.title) || root;
  return (
    <DefLayout
      path={path}
      kindLabel={kindLabel}
      properties={properties}
      objectName={text(file.title) || thisId}
      tools={
        !readOnly && (
          <ToolbarGroup>
            <ToolbarSelect
              label={t("Frame")}
              value={frame(file)}
              options={FRAMES.map((f) => ({ value: f, label: t(FRAME_LABELS[f]) }))}
              onChange={(v) => update((d) => void (d.frame = v === "task" ? undefined : v))}
            />
            <ToolbarCheck label="Hidden" checked={file.hidden === true} onChange={(v) => update((d) => void (d.hidden = v || undefined))} />
          </ToolbarGroup>
        )
      }
    >
      <GameStage width={WINDOW.w} height={WINDOW.h} panel={false} className="advancement-stage">
        {(k) => {
          const sx = Math.floor(scroll.x);
          const sy = Math.floor(scroll.y);
          const px = (v: number) => v * k;
          // `AdvancementWidget.drawConnectivity`: the game's hLine/vLine rectangles, black under white.
          const lines: { x: number; y: number; w: number; h: number; c: string }[] = [];
          const hLine = (a: number, b: number, y: number, c: string) => lines.push({ x: Math.min(a, b), y, w: Math.abs(a - b) + 1, h: 1, c });
          const vLine = (x: number, a: number, b: number, c: string) => lines.push({ x, y: Math.min(a, b) + 1, w: 1, h: Math.max(0, Math.abs(a - b) - 1), c });
          for (const shadow of [true, false]) {
            for (const n of tab) {
              const p = n.parent ? place.get(n.parent) : undefined;
              const c = place.get(n.id);
              if (!p || !c || n.parent === n.id) continue;
              const [i, j, kk, l, m] = [p.x + CONNECT.mid, p.x + CONNECT.out, p.y + CONNECT.mid, c.x + CONNECT.mid, c.y + CONNECT.mid];
              if (shadow) {
                const b = "#000";
                hLine(j, i, kk - 1, b), hLine(j + 1, i, kk, b), hLine(j, i, kk + 1, b);
                hLine(l, j - 1, m - 1, b), hLine(l, j - 1, m, b), hLine(l, j - 1, m + 1, b);
                vLine(j - 1, m, kk, b), vLine(j + 1, m, kk, b);
              } else {
                const w = "#fff";
                hLine(j, i, kk, w), hLine(l, j, m, w), vLine(j, m, kk, w);
              }
            }
          }
          const windowUrl = imageNatural(path, WINDOW_SPRITE);
          return (
            <div className="adv-window" style={{ width: px(WINDOW.w), height: px(WINDOW.h) }}>
              <div
                className="adv-view"
                style={{
                  left: px(VIEW.x),
                  top: px(VIEW.y),
                  width: px(VIEW.w),
                  height: px(VIEW.h),
                  backgroundImage: background ? `url(${background})` : undefined,
                  backgroundSize: px(TILE),
                  backgroundPosition: `${px(sx % TILE)}px ${px(sy % TILE)}px`,
                }}
                onPointerDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  const start = { x: e.clientX, y: e.clientY, from: drag };
                  const move = (ev: PointerEvent) => setDrag({ x: start.from.x + (ev.clientX - start.x) / k, y: start.from.y + (ev.clientY - start.y) / k });
                  const up = () => (window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up));
                  window.addEventListener("pointermove", move);
                  window.addEventListener("pointerup", up);
                }}
              >
                <svg className="adv-lines" width={px(VIEW.w)} height={px(VIEW.h)} shapeRendering="crispEdges">
                  {lines.map((r, i) => (
                    <rect key={i} x={px(sx + r.x)} y={px(sy + r.y)} width={px(r.w)} height={px(r.h)} fill={r.c} />
                  ))}
                </svg>
                {tab.map((n) => {
                  const p = place.get(n.id)!;
                  const mine = n.id === thisId;
                  const frameUrl = imageNatural(path, frameSprite(frame(n.value), mine));
                  return (
                    <button
                      key={n.id}
                      type="button"
                      className={`adv-node${mine ? " is-this" : ""}${n.file ? "" : " is-outside"}`}
                      style={{ left: px(sx + p.x + FRAME_DX), top: px(sy + p.y), width: px(FRAME), height: px(FRAME) }}
                      onPointerEnter={() => setHover(n.id)}
                      onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
                      onClick={() => n.file && !mine && openFile({ path: n.file })}
                    >
                      {frameUrl && <img className="game-icon" src={frameUrl} alt="" draggable={false} style={{ width: px(FRAME), height: px(FRAME) }} />}
                      <span className="adv-icon" style={{ left: px(ICON_AT.x - FRAME_DX), top: px(ICON_AT.y) }}>
                        <ItemIcon path={path} id={n.value.icon as string | undefined} k={k} title="" />
                      </span>
                    </button>
                  );
                })}
              </div>
              {windowUrl && <img className="adv-frame game-icon" src={windowUrl} alt="" draggable={false} style={{ width: px(WINDOW.w), height: px(WINDOW.h) }} />}
              <div className="game-title" style={{ left: px(TITLE_AT.x), top: px(TITLE_AT.y) }}>
                {shownTitle}
              </div>
              {hover &&
                (() => {
                  const n = tab.find((x) => x.id === hover);
                  const p = place.get(hover);
                  if (!n || !p) return null;
                  return (
                    <div className="game-tooltip adv-tooltip" style={{ left: px(VIEW.x + sx + p.x + FRAME_DX + FRAME), top: px(VIEW.y + sy + p.y) }}>
                      <div>{text(n.value.title) || n.id}</div>
                      {typeof n.value.description === "string" && <div className="is-muted adv-desc">{text(n.value.description)}</div>}
                      {!n.file && <div className="is-muted">{t("Not the mod's: {id}", { id: n.id })}</div>}
                    </div>
                  );
                })()}
            </div>
          );
        }}
      </GameStage>
    </DefLayout>
  );
}

/** An advancement's criteria: each how it's earned and, for items, which. */
function CriteriaEditor({ criteria, items, readOnly, onChange }: { criteria: Record<string, unknown>[]; items: RefChoices; readOnly: boolean; onChange: (c: Record<string, unknown>[]) => void }) {
  const t = useT();
  const suggestions = refSuggestions(items, "item");
  const set = (i: number, c: Record<string, unknown>) => onChange(criteria.map((x, j) => (j === i ? c : x)));
  return (
    <div className="item-list">
      {criteria.map((c, i) => {
        const kind = criterionKind(c);
        const value = kind === "granted" ? "" : String(c[kind] ?? "");
        const problem = kind === "granted" ? null : refMessage(t, refProblem(value, "item", items, kind === "has_item"), "item");
        return (
          <div key={i} className="crit-row">
            <SelectField
              value={kind}
              disabled={readOnly}
              options={CRITERIA.map((k) => ({ value: k, label: t(CRITERION_LABELS[k]) }))}
              onChange={(k) => set(i, k === "granted" ? { granted: true } : { [k]: value })}
            />
            {kind !== "granted" && (
              <TextField
                list="crit-items"
                defaultValue={value}
                key={value}
                disabled={readOnly}
                title={problem ?? value}
                className={problem ? "is-invalid" : undefined}
                onBlur={(e) => e.target.value.trim() !== value && set(i, { [kind]: e.target.value.trim() })}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
            )}
            {!readOnly && (
              <IconButton size="sm" title={t("Remove")} aria-label={t("Remove")} onClick={() => onChange(criteria.filter((_, j) => j !== i))}>
                <Icon name="trash" size={12} />
              </IconButton>
            )}
          </div>
        );
      })}
      <datalist id="crit-items">
        {suggestions.slice(0, 500).map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      {!readOnly && (
        <div>
          <IconButton size="sm" title={t("Add")} aria-label={t("Add")} onClick={() => onChange([...criteria, { granted: true }])}>
            <Icon name="plus" size={12} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
