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
import { GameStage, ItemIcon } from "./GamePanel";
import "./defs.css";

const FRAME_LABELS: Record<(typeof FRAMES)[number], string> = { task: "Task", goal: "Goal", challenge: "Challenge" };
const CRITERION_LABELS: Record<Criterion, string> = { granted: "Granted by the Mod", has_item: "Has an Item", used_item: "Used an Item" };

/** A cell of the tab, GUI pixels (a frame is 26). */
const CELL_W = 30;
const CELL_H = 28;
const PAD = 10;
const TITLE = 14;

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
    const out: Shown[] = defs.filter((d) => d.file !== path && d.id !== thisId).map((d) => ({ id: d.id, parent: parentOf(d.value), file: d.file, value: d.value }));
    out.push({ id: thisId, parent: parentOf(file), file: path, value: file });
    for (const n of [...out]) if (n.parent && !out.some((o) => o.id === n.parent)) out.push({ id: n.parent, parent: null, file: null, value: {} });
    return out;
  }, [defs, file, path, thisId]);
  const root = rootOf(nodes, thisId);
  const tab = tabOf(nodes, root) as Shown[];
  const at = layoutTree(tab);
  const cols = Math.max(...[...at.values()].map((p) => p.x), 0) + 1;
  const rows = Math.max(...[...at.values()].map((p) => p.y), 0) + 1;
  const width = Math.max(cols * CELL_W + PAD * 2, 176);
  const height = rows * CELL_H + PAD * 2 + TITLE;
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
        description: t("How its frame looks: a task (square), a goal (rounded) or a challenge (spiked)."),
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
      name: t("Criteria"),
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
      <GameStage width={width} height={height} panel={false}>
        {(k) => (
          <div className="adv-tab" style={{ width: width * k, height: height * k, backgroundImage: background ? `url(${background})` : undefined, backgroundSize: `${16 * k}px` }}>
            <div className="adv-title" style={{ height: TITLE * k, paddingLeft: PAD * k }}>
              {shownTitle}
            </div>
            <svg className="adv-lines" width={width * k} height={height * k}>
              {tab.map((n) => {
                const p = n.parent ? at.get(n.parent) : undefined;
                const c = at.get(n.id);
                if (!p || !c || n.parent === n.id) return null;
                const cx = (PAD + c.x * CELL_W) * k;
                const cy = (TITLE + PAD + c.y * CELL_H + 13) * k;
                const px = (PAD + p.x * CELL_W + 26) * k;
                const py = (TITLE + PAD + p.y * CELL_H + 13) * k;
                const mx = (px + cx) / 2;
                const d = `M${px} ${py} H${mx} V${cy} H${cx}`;
                return (
                  <g key={n.id}>
                    <path d={d} stroke="#000" strokeWidth={3 * k} fill="none" />
                    <path d={d} stroke="#fff" strokeWidth={k} fill="none" />
                  </g>
                );
              })}
            </svg>
            {tab.map((n) => {
              const p = at.get(n.id)!;
              const mine = n.id === thisId;
              return (
                <button
                  key={n.id}
                  type="button"
                  className={`adv-node frame-${frame(n.value)}${mine ? " is-this" : ""}${n.file ? "" : " is-outside"}`}
                  style={{ left: (PAD + p.x * CELL_W) * k, top: (TITLE + PAD + p.y * CELL_H) * k, width: 26 * k, height: 26 * k }}
                  onPointerEnter={() => setHover(n.id)}
                  onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
                  onClick={() => n.file && !mine && openFile({ path: n.file })}
                >
                  <ItemIcon path={path} id={n.value.icon as string | undefined} k={k} title="" />
                </button>
              );
            })}
            {hover &&
              (() => {
                const n = tab.find((x) => x.id === hover);
                const p = at.get(hover);
                if (!n || !p) return null;
                return (
                  <div className="game-tooltip adv-tooltip" style={{ left: (PAD + p.x * CELL_W + 28) * k, top: (TITLE + PAD + p.y * CELL_H) * k, maxWidth: 160 * k }}>
                    <div>{text(n.value.title) || n.id}</div>
                    {typeof n.value.description === "string" && <div className="is-muted adv-desc">{text(n.value.description)}</div>}
                    {!n.file && <div className="is-muted">{t("Not the mod's: {id}", { id: n.id })}</div>}
                  </div>
                );
              })()}
          </div>
        )}
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
