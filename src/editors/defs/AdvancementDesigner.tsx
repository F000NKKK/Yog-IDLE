import { useEffect, useMemo, useState } from "react";
import { useTyped } from "../../data/typed";
import { cli } from "../../cli";
import { Icon, IconButton, openFile, type PropertyDescriptor, SelectField, TextField, ToolbarCheck, ToolbarGroup, ToolbarSelect, useT } from "substrate-platform-ui";
import { qualify, refId, refProblem, refSuggestions, useContentDefs, useContentRefs, type RefChoices } from "../../data/contentRefs";
import { designText, useDesignResources } from "../../lang/designResources";
import { modRootOf } from "../../paths";
import { inspectorRows, refMessage } from "../inspector";
import { asList, CRITERIA, criterionKind, FRAMES, rootOf, tabOf, type AdvNode, type Criterion } from "./defModel";
import { DefLayout, type DefProps } from "./DefLayout";
import { GameStage } from "./GamePanel";
import { GAME_NAMESPACE, idParts } from "../../data/yogFormat";
import "./defs.css";
import { kind as KIND, serveMethod } from "../../data/yogIds.generated";

const FRAME_LABELS: Record<(typeof FRAMES)[number], string> = { task: "Task", goal: "Goal", challenge: "Challenge" };
const CRITERION_LABELS: Record<Criterion, string> = { granted: "Granted by the Mod", has_item: "Has an Item", used_item: "Used an Item" };

/** The screen the backend draws (`designer::advancements::SCREEN`), GUI pixels. */
interface Rendered {
  image: string | null;
  size: [number, number];
  view: [number, number, number, number];
  spots: { id: string; rect: [number, number, number, number] }[];
  drag: [number, number];
}

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
  // Typed values (`@item:…`) classified by the CLI come in: draw again.
  useTyped();
  const t = useT();
  useDesignResources(modRootOf(path));
  const defs = useContentDefs(path, KIND.ADVANCEMENT);
  const advancements = useContentRefs(path, KIND.ADVANCEMENT);
  const items = useContentRefs(path, KIND.ITEM);
  const [strings, setStrings] = useState<string[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    cli<string[]>(serveMethod.CONTENT_STRINGS, { path }).then((s) => setStrings(s ?? []), () => setStrings([]));
  }, [path]);

  const first = defs[0]?.id ?? advancements.own[0]?.id;
  const ns = first ? idParts(first)[0] : GAME_NAMESPACE;
  const thisId = qualify(file.id ?? path.split(/[\\/]/).pop()!.replace(/\.ydef$/, ""), ns);
  const parentOf = (v: Record<string, unknown>) => (typeof v.parent === "string" ? refId(v.parent, KIND.ADVANCEMENT) : null);

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
  const rootNode = tab.find((n) => n.id === root);

  const bg = typeof rootNode?.value.background === "string" ? rootNode.value.background : null;
  const text = (v: unknown) => (typeof v === "string" ? designText(v) : "");
  const frame = (v: Record<string, unknown>) => (FRAMES.includes(v.frame as never) ? (v.frame as string) : "task");

  // The tab drawn by the backend as the game draws it; dragged and hovered here.
  const [drag, setDrag] = useState<[number, number]>([0, 0]);
  const [drawn, setDrawn] = useState<Rendered | null>(null);
  // The files' values as written: the CLI reads the references and texts.
  const written = (v: unknown) => (typeof v === "string" ? v : null);
  const args = useMemo(
    () => ({
      path,
      title: written(rootNode?.value.title),
      background: bg,
      nodes: tab.map((n) => ({
        id: n.id,
        parent: n.parent,
        icon: written(n.value.icon),
        frame: frame(n.value),
        title: written(n.value.title),
        description: written(n.value.description),
        obtained: n.id === thisId,
      })),
      drag,
      hover,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `text` reads the design resources, `tab` is rebuilt each render
    [path, JSON.stringify(tab.map((n) => [n.id, n.parent, n.value])), bg, drag, hover, thisId, root],
  );
  useEffect(() => {
    let live = true;
    cli<Rendered>(serveMethod.ADVANCEMENT_RENDER, { args }).then(
      (r) => {
        if (!live) return;
        setDrawn(r);
        if (r.drag[0] !== drag[0] || r.drag[1] !== drag[1]) setDrag(r.drag);
      },
      () => live && setDrawn(null),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `drag` is in `args`
  }, [args]);

  // ── Properties ────────────────────────────────────────────────────────────

  const properties = useMemo<PropertyDescriptor[]>(() => {
    const { text: row, ref, choice, flag } = inspectorRows(t, readOnly, path);
    const c = t("Advancement");
    const out: PropertyDescriptor[] = [
      row("id", t("Id"), c, file.id, (v) => update((d) => void (d.id = v)), { description: t("Its id: a path of the mod's (lore/cardamom1).") }),
      ref("parent", t("Parent"), c, file.parent as string | undefined, KIND.ADVANCEMENT, { ...advancements, own: advancements.own.filter((o) => o.id !== thisId) }, (v) => update((d) => void (d.parent = v)), {
        description: t("The advancement it hangs under; none: the root of a tab of its own."),
      }),
      ref("icon", t("Icon"), c, file.icon as string | undefined, KIND.ITEM, items, (v) => update((d) => void (d.icon = v)), { description: t("The item drawn in its frame.") }),
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
      <GameStage width={drawn?.size[0] ?? 1} height={drawn?.size[1] ?? 1} panel={false} className="advancement-stage">
        {(k) => {
          if (!drawn?.image) return null;
          const gui = (e: { clientX: number; clientY: number; currentTarget: Element }) => {
            const r = e.currentTarget.getBoundingClientRect();
            return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
          };
          const inside = (p: { x: number; y: number }, [x, y, w, h]: number[]) => p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
          const spotAt = (p: { x: number; y: number }) => drawn.spots.find((s) => inside(p, s.rect))?.id ?? null;
          return (
            <img
              className="adv-screen game-icon"
              src={drawn.image}
              alt=""
              draggable={false}
              style={{ width: drawn.size[0] * k, height: drawn.size[1] * k, pointerEvents: "auto" }}
              onPointerMove={(e) => {
                const p = gui(e);
                setHover(inside(p, drawn.view) ? spotAt(p) : null);
              }}
              onPointerLeave={() => setHover(null)}
              onPointerDown={(e) => {
                const p = gui(e);
                const id = inside(p, drawn.view) ? spotAt(p) : null;
                if (id) {
                  const n = tab.find((x) => x.id === id);
                  if (n?.file && n.id !== thisId) openFile({ path: n.file });
                  return;
                }
                if (!inside(p, drawn.view)) return;
                const start = { x: e.clientX, y: e.clientY, from: drag };
                const move = (ev: PointerEvent) => setDrag([start.from[0] + (ev.clientX - start.x) / k, start.from[1] + (ev.clientY - start.y) / k]);
                const up = () => (window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up));
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
              }}
            />
          );
        }}
      </GameStage>
    </DefLayout>
  );
}

/** An advancement's criteria: each how it's earned and, for items, which. */
function CriteriaEditor({ criteria, items, readOnly, onChange }: { criteria: Record<string, unknown>[]; items: RefChoices; readOnly: boolean; onChange: (c: Record<string, unknown>[]) => void }) {
  const t = useT();
  const suggestions = refSuggestions(items, KIND.ITEM);
  const set = (i: number, c: Record<string, unknown>) => onChange(criteria.map((x, j) => (j === i ? c : x)));
  return (
    <div className="item-list">
      {criteria.map((c, i) => {
        const kind = criterionKind(c);
        const value = kind === "granted" ? "" : String(c[kind] ?? "");
        const problem = kind === "granted" ? null : refMessage(t, refProblem(value, KIND.ITEM, items, kind === "has_item"), KIND.ITEM);
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
