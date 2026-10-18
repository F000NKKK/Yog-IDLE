import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { KeyHints, Toolbar, ToolbarButton, ToolbarCheck, ToolbarGroup, ToolbarSelect, usePropertyContext, useT, type EditorProps, type KeyHint, type PropertyDescriptor } from "substrate-platform-ui";
import { ModelViewport, type ViewOverlay } from "../body/ModelViewport";
import { SpawnEgg } from "../designer/TintedItem";
import { ownNamespace, useBody } from "../body/useBody";
import { samplePose } from "../body/yanim";
import {
  bodyRef,
  CATEGORIES,
  COMMON_ATTRIBUTES,
  ENTITY_DEFAULTS,
  ENTITY_KINDS,
  eyeHeight,
  GAME_GOALS,
  GAME_STATES,
  isLiving,
  kindOf,
  parseEntity,
  patchEntity,
  pushable,
  type EntityFile,
  type EntityKind,
} from "../body/yentity";
import { blankModel } from "../body/ymodel";
import { useContentRefs } from "../data/contentRefs";
import { clone } from "../content/model";
import { inspectorRows } from "./inspector";
import { ItemList } from "./ItemList";
import "./designers.css";

export const ENTITY_SOURCE_VIEW = "yog.yentity.source";

/** Each kind's name as the designer shows it. */
const KIND_LABELS: Record<EntityKind, string> = { object: "Object", living: "Living", mob: "Mob", hanging: "Hanging" };

/** A new spawn egg's colors: the game's pig. */
const DEFAULT_EGG: [number, number] = [0xf0a5a2, 0xdb635f];

/** The view's controls (Properties lists them). */
const CONTROLS: KeyHint[] = [
  { action: "Orbit", keys: "mmb" },
  { action: "Pan", keys: "shift+mmb" },
  { action: "Zoom", keys: "wheel" },
  { action: "Front / side / top", keys: ["num1", "num3", "num7"] },
];

/** A game attribute's id as an entity names it: `minecraft:generic.max_health` → `max_health`. */
const attributeName = (id: string) => id.replace(/^minecraft:/, "").replace(/^generic\./, "");

/**
 * The `.yentity` designer: the entity as it stands in the world — its body
 * model posed by a clip (played, scrubbed from the toolbar), its hitbox and
 * eyes, a hanging thing's wall — and everything it says in Properties: its
 * kind and size, attributes, goals in priority order, its model, clips by
 * state, spawn egg colors (drawn as the game does) and a hanging thing's
 * sounds. Edits go into the file's text, comments kept; Undo/Redo are the
 * platform's.
 */
export function EntityEditor({ path, content, onChange, readOnly }: EditorProps) {
  const t = useT();
  const parsed = useMemo(() => parseEntity(content), [content]);
  const file = useMemo<EntityFile>(() => (parsed.ok ? parsed.file : {}), [parsed]);
  const kind = kindOf(file);
  const living = isLiving(kind);
  const body = useBody(path, file.model, file.animations);
  const attributes = useContentRefs(path, "attribute");
  const sounds = useContentRefs(path, "sound");
  const [strings, setStrings] = useState<string[]>([]);
  const [hitbox, setHitbox] = useState(true);
  const [grid, setGrid] = useState(true);
  const [clipName, setClipName] = useState("");
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);

  useEffect(() => {
    let live = true;
    invoke<string[]>("content_strings", { path })
      .then((s) => live && setStrings(s ?? []))
      .catch(() => live && setStrings([]));
    return () => {
      live = false;
    };
  }, [path]);

  const contentRef = useRef(content);
  contentRef.current = content;
  const update = useCallback(
    (edit: (draft: EntityFile) => void) => {
      if (readOnly || !parsed.ok) return;
      const draft = clone(parsed.file);
      edit(draft);
      const text = patchEntity(contentRef.current, draft);
      if (text !== contentRef.current) onChange(text);
    },
    [onChange, readOnly, parsed],
  );

  // The clip shown: picked, else the idle state's; played in real time.
  const clip = body.clips.find((c) => c.name === (clipName || file.clips?.idle)) ?? null;
  useEffect(() => {
    if (!playing || !clip) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      setTime((x) => x + (now - last) / 1000);
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, clip]);
  const pose = useMemo(() => (clip ? samplePose(clip, time) : null), [clip, time]);

  const overlay = useMemo<ViewOverlay>(() => {
    const w = file.width ?? 0;
    const h = file.height ?? 0;
    if (kind === "hanging") return { wall: { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) } };
    return hitbox ? { hitbox: { width: w, height: h, eye: living ? eyeHeight(file) : undefined } } : {};
  }, [file, kind, living, hitbox]);
  const shownModel = useMemo(() => body.model ?? blankModel(), [body.model]);
  const blank = useMemo(() => ({ ...shownModel, bones: [] }), [shownModel]);

  // ── Properties ────────────────────────────────────────────────────────────

  const ns = ownNamespace(body.models) ?? ownNamespace(body.animations);
  const properties = useMemo<PropertyDescriptor[]>(() => {
    const ro = !!readOnly;
    const { text, num, choice, flag, color } = inspectorRows(t, ro, path);
    const out: PropertyDescriptor[] = [];
    const general = t("General");
    out.push(
      text("id", t("Id"), general, file.id, (v) => update((d) => void (d.id = v)), {
        description: t("The registry id — `namespace:name`, or just `name` (the mod's namespace). Default: the file name."),
      }),
      text("name", t("Name"), general, file.name, (v) => update((d) => void (d.name = v)), {
        suggestions: strings,
        description: t("Its name — a literal English text or a `@Set.name` text of a .yres file (translated). Default: the id's translation key."),
      }),
      {
        id: "kind",
        name: t("Kind"),
        category: general,
        value: kind,
        kind: "enum",
        options: ENTITY_KINDS,
        optionLabel: (o) => t(KIND_LABELS[o as EntityKind] ?? o),
        readOnly: ro,
        description: t("object: a thing with no health or AI; living: health and attributes; mob: a creature with AI goals; hanging: hangs on a wall, as a painting."),
        onCommit: (v) => update((d) => void (d.kind = v === "object" ? undefined : (v as EntityKind))),
      },
      choice("category", t("Spawn Group"), general, file.category, CATEGORIES, (v) => update((d) => void (d.category = v === ENTITY_DEFAULTS.category ? undefined : v)), {
        description: t("Its spawn group (the game's MobCategory): how many of it the world spawns and where. Default: misc."),
      }),
    );

    const size = t("Size");
    const blocks = kind === "hanging" ? t("Whole blocks of wall it covers.") : t("Its hitbox, blocks.");
    out.push(
      num("width", t("Width"), size, file.width, (v) => update((d) => void (d.width = v)), { min: 0, description: blocks }),
      num("height", t("Height"), size, file.height, (v) => update((d) => void (d.height = v)), { min: 0, description: blocks }),
    );
    if (kind !== "hanging")
      out.push(
        num("eye_height", t("Eye Height"), size, file.eye_height, (v) => update((d) => void (d.eye_height = v)), {
          min: 0,
          displayValue: file.eye_height === undefined ? t("{value} (default)", { value: Math.round(eyeHeight(file) * 1000) / 1000 }) : undefined,
          description: t("Where it looks from, blocks above its feet. Default: 85% of its height."),
        }),
      );

    // Its look: the model, its clips, which plays in which state.
    const look = t("Body");
    const own = (list: typeof body.models) => list.map((o) => (ns ? bodyRef(o.id, ns) : o.id));
    const known = (list: typeof body.models) => (v: unknown) => {
      const s = String(v).trim();
      if (!s || s.includes(":") || list.some((o) => ns && bodyRef(o.id, ns) === s)) return null;
      return t("No such file in the mod's content/.");
    };
    out.push(
      text("model", t("Model"), look, file.model, (v) => update((d) => void (d.model = v)), {
        suggestions: own(body.models),
        validate: known(body.models),
        description: t("Its body model: a .ymodel of the mod by its path under content/ (body/wisp) or another mod's by id. None: the mod draws it (on_body)."),
      }),
      text("animations", t("Animations"), look, file.animations, (v) => update((d) => void (d.animations = v)), {
        suggestions: own(body.animations),
        validate: known(body.animations),
        description: t("Its clips: a .yanim of the mod by its path under content/ (body/wisp_anims)."),
      }),
    );
    const clipNames = body.clips.map((c) => c.name);
    for (const [state, name] of Object.entries(file.clips ?? {})) {
      out.push({
        id: `clip.${state}`,
        name: state,
        category: t("Clips by State"),
        value: name,
        kind: "string",
        suggestions: clipNames,
        readOnly: ro,
        description: t("The clip it plays in this state. Empty: none."),
        onCommit: (v) =>
          update((d) => {
            const s = String(v).trim();
            d.clips = { ...(d.clips ?? {}) };
            if (s) d.clips[state] = s;
            else delete d.clips[state];
            if (!Object.keys(d.clips).length) delete d.clips;
          }),
      });
    }
    out.push({
      id: "clip.add",
      name: t("Add State"),
      category: t("Clips by State"),
      value: "",
      kind: "string",
      suggestions: GAME_STATES.filter((s) => !(s in (file.clips ?? {}))),
      readOnly: ro,
      description: t("idle, walk, attack, hurt, death — or the mod's own state (entity data yog:state): the clip of the same name plays in it."),
      onCommit: (v) => {
        const state = String(v).trim();
        if (!state) return;
        update((d) => void (d.clips = { ...(d.clips ?? {}), [state]: clipNames.includes(state) ? state : (clipNames[0] ?? state) }));
      },
    });

    if (living) {
      const cat = t("Attributes");
      const names = [...COMMON_ATTRIBUTES, ...attributes.game.map(attributeName), ...attributes.own.map((o) => o.id)];
      for (const [name, value] of Object.entries(file.attributes ?? {})) {
        out.push(
          num(`attr.${name}`, name, cat, value, (v) =>
            update((d) => {
              d.attributes = { ...(d.attributes ?? {}) };
              if (v === undefined) delete d.attributes[name];
              else d.attributes[name] = v;
              if (!Object.keys(d.attributes).length) delete d.attributes;
            }), { description: t("Its base value. Empty: removed.") }),
        );
      }
      out.push({
        id: "attr.add",
        name: t("Add Attribute"),
        category: cat,
        value: "",
        kind: "string",
        suggestions: [...new Set(names)].filter((n) => !(n in (file.attributes ?? {}))),
        readOnly: ro,
        description: t("The game's by name (max_health, movement_speed, attack_damage…) or a mod's by id (mymod:grid_zoom): set to 1 to start with."),
        onCommit: (v) => {
          const name = String(v).trim();
          if (name) update((d) => void (d.attributes = { ...(d.attributes ?? {}), [name]: d.attributes?.[name] ?? 1 }));
        },
      });
    }

    if (kind === "mob")
      out.push({
        id: "goals",
        name: t("Goals"),
        category: t("Goals"),
        value: null,
        kind: "custom",
        description: t("What it does by itself, the first the most important: the game's goals by name."),
        render: () => (
          <ItemList
            items={file.goals ?? []}
            ordered
            readOnly={ro}
            suggestions={GAME_GOALS}
            placeholder={t("Add a goal…")}
            onChange={(goals) => update((d) => void (d.goals = goals.length ? goals : undefined))}
          />
        ),
      });

    const behaviour = t("Behaviour");
    out.push(
      flag("fire_immune", t("Fire Immune"), behaviour, file.fire_immune, false, (v) => update((d) => void (d.fire_immune = v)), { description: t("Lava and fire don't hurt it.") }),
      flag("no_gravity", t("No Gravity"), behaviour, file.no_gravity, false, (v) => update((d) => void (d.no_gravity = v)), { description: t("It doesn't fall.") }),
      flag("pushable", t("Pushable"), behaviour, file.pushable, pushable({ ...file, pushable: undefined }), (v) => update((d) => void (d.pushable = v)), {
        description: t("Others push it. Default: living things are pushed, others aren't."),
      }),
      flag("solid", t("Solid"), behaviour, file.solid, false, (v) => update((d) => void (d.solid = v)), { description: t("Others stand on it and bump into it as into a block (a boat).") }),
      flag("ticks", t("Ticks"), behaviour, file.ticks, false, (v) => update((d) => void (d.ticks = v)), { description: t("The mod handles each tick of every entity of this type (on_entity_tick).") }),
      num("tracking_range", t("Tracking Range"), behaviour, file.tracking_range, (v) => update((d) => void (d.tracking_range = v === ENTITY_DEFAULTS.tracking_range ? undefined : v)), {
        min: 1,
        int: true,
        displayValue: file.tracking_range === undefined ? t("{value} (default)", { value: ENTITY_DEFAULTS.tracking_range }) : undefined,
        description: t("How far players see it, chunks."),
      }),
      num("update_interval", t("Update Interval"), behaviour, file.update_interval, (v) => update((d) => void (d.update_interval = v === ENTITY_DEFAULTS.update_interval ? undefined : v)), {
        min: 1,
        int: true,
        displayValue: file.update_interval === undefined ? t("{value} (default)", { value: ENTITY_DEFAULTS.update_interval }) : undefined,
        description: t("How often its movement is sent, ticks."),
      }),
    );

    if (living) {
      const egg = t("Spawn Egg");
      const colors = file.spawn_egg;
      out.push(
        flag("spawn_egg", t("Spawn Egg"), egg, !!colors, false, (v) => update((d) => void (d.spawn_egg = v ? (d.spawn_egg ?? DEFAULT_EGG) : undefined)), {
          description: t("It has a spawn egg, in the game's spawn egg tab."),
        }),
      );
      if (colors)
        out.push(
          color("egg.base", t("Base Color"), egg, colors[0], (v) => v !== undefined && update((d) => void (d.spawn_egg = [v, d.spawn_egg?.[1] ?? DEFAULT_EGG[1]]))),
          color("egg.spots", t("Spots Color"), egg, colors[1], (v) => v !== undefined && update((d) => void (d.spawn_egg = [d.spawn_egg?.[0] ?? DEFAULT_EGG[0], v]))),
          { id: "egg.preview", name: t("Preview"), category: egg, value: null, kind: "custom", render: () => <SpawnEgg path={path} colors={colors} /> },
        );
    }

    if (kind === "hanging") {
      const hang = t("Hanging");
      const events = sounds.game;
      out.push(
        text("place_sound", t("Place Sound"), hang, file.place_sound, (v) => update((d) => void (d.place_sound = v)), {
          suggestions: events,
          displayValue: file.place_sound === undefined ? t("{value} (default)", { value: ENTITY_DEFAULTS.place_sound }) : undefined,
          description: t("The sound event when it's hung. Default: a painting's."),
        }),
        text("break_sound", t("Break Sound"), hang, file.break_sound, (v) => update((d) => void (d.break_sound = v)), {
          suggestions: events,
          displayValue: file.break_sound === undefined ? t("{value} (default)", { value: ENTITY_DEFAULTS.break_sound }) : undefined,
          description: t("The sound event when it breaks. Default: a painting's."),
        }),
      );
    }
    return out;
  }, [file, kind, living, readOnly, t, path, update, strings, body.models, body.animations, body.clips, attributes, sounds, ns]);

  usePropertyContext(path, parsed.ok ? { order: "declared", objectName: file.id ?? path.split(/[\\/]/).pop()?.replace(/\.yentity$/, ""), objectType: t("Entity"), objectKey: path, properties, footer: <KeyHints hints={CONTROLS} /> } : null);

  if (!parsed.ok) return <div className="designer-error">{t("This file has a mistake: {error}", { error: parsed.error })}</div>;

  const states = Object.entries(file.clips ?? {});
  const clipOptions = [
    { value: "", label: t("Rest") },
    ...states.map(([state, name]) => ({ value: name, label: `${state} → ${name}`, group: t("States") })),
    ...body.clips.map((c) => ({ value: c.name, label: c.name, group: t("Clips") })),
  ];
  const note = !file.model
    ? t("No model: the mod draws it (on_body).")
    : !body.model
      ? t("Model {model} isn't in the mod's content/.", { model: file.model })
      : null;
  return (
    <div className="designer">
      <Toolbar>
        <ToolbarGroup>
          <ToolbarSelect
            label={t("Kind")}
            value={kind}
            disabled={readOnly}
            options={ENTITY_KINDS.map((k) => ({ value: k, label: t(KIND_LABELS[k]) }))}
            onChange={(v) => update((d) => void (d.kind = v === "object" ? undefined : (v as EntityKind)))}
          />
        </ToolbarGroup>
        <ToolbarGroup>
          <ToolbarSelect label={t("Clip")} value={clip?.name ?? ""} options={clipOptions} disabled={!body.clips.length} onChange={(v) => (setClipName(v), setTime(0))} />
          <ToolbarButton icon={playing ? "pause" : "play"} label={playing ? "Pause" : "Play"} disabled={!clip} onClick={() => setPlaying((p) => !p)} />
          <ToolbarButton icon="skipBack" label="To the Start" disabled={!clip} onClick={() => setTime(0)} />
        </ToolbarGroup>
        <ToolbarGroup>
          <ToolbarCheck label="Hitbox" checked={hitbox} disabled={kind === "hanging"} onChange={setHitbox} />
          <ToolbarCheck label="Grid" checked={grid} onChange={setGrid} />
        </ToolbarGroup>
      </Toolbar>
      <div className="designer-body">
        <ModelViewport
          className="entity-view"
          style={{ flex: 1 }}
          model={body.model ? shownModel : blank}
          texture={body.texture}
          selection={null}
          onSelect={() => {}}
          onBone={() => {}}
          onCube={() => {}}
          onLocator={() => {}}
          mode="translate"
          onMode={() => {}}
          snap={{ move: 0, turn: 0 }}
          showGrid={grid}
          pose={pose}
          overlay={overlay}
        />
        {note && <div className="designer-note">{note}</div>}
      </div>
    </div>
  );
}
