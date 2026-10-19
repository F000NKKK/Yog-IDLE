// The block's or item's own properties.

import { type PropertyDescriptor, pt, t } from "substrate-platform-ui";
import { ARMOR_SLOTS, type ArmorSlot, type ContentFile, RENDER_LAYERS, TOOL_KINDS, TOOL_LEVELS, TOOLS } from "../../../content/model";
import { refProblem, refSuggestions } from "../../../data/contentRefs";
import { RowsEditor } from "../../RowsEditor";
import { refMessage } from "../../inspector";
import type { PotionEffectRow } from "../contentModel";
import { parseVec, vecText } from "../fieldText";
import type { PropertiesContext } from "./context";

/** The block's or item's own properties. */
export function blockItemRows(ctx: PropertiesContext, out: PropertyDescriptor[]): void {
  const { file, kind, update, choices, blockKinds, blockRefs, effectRefs, entityRefs, num, text, choice, flag, vec, prune, yesNoProperties } = ctx;
  const ro = ctx.readOnly;
  // Block / item properties.
  if (kind === "block") {
    const c = t("Block");
    const b = file.block ?? {};
    const blockKind = blockKinds.find((candidate) => candidate.name === file.kind);
    const setB = (edit: (b: NonNullable<ContentFile["block"]>) => void) =>
      update((d) => {
        d.block ??= {};
        edit(d.block);
        if (prune(d.block as Record<string, unknown>)) delete d.block;
      });
    const drops = typeof b.drops === "object" ? (b.drops.item ?? "").replace(/^@item:/, "") : (b.drops ?? "");
    const tools = Array.isArray(b.tool) ? b.tool.join(", ") : b.tool;
    out.push(
      choice("block_kind", t("Block Kind"), c, file.kind, [...new Set([...blockKinds.map((candidate) => candidate.name), ...(file.kind ? [file.kind] : [])])], (v) =>
        update((d) => {
          if (v) d.kind = v;
          else delete d.kind;
          const takes = blockKinds.find((candidate) => candidate.name === v)?.takes ?? [];
          if (d.block) {
            for (const field of ["base", "set", "press_ticks", "triggered_by"] as const) {
              if (!takes.includes(field)) delete d.block[field];
            }
            if (prune(d.block as Record<string, unknown>)) delete d.block;
          }
        }), {
        optionLabel: (name) => t(name),
        description: t("Use a built-in block class (stairs, slabs, doors, buttons and related blocks); its states, models and item form come from the game."),
      }),
      num("hardness", t("Hardness"), c, b.hardness, (v) => setB((x) => void (x.hardness = v)), { min: -1, description: t("Mining time factor (stone 1.5, -1 unbreakable).") }),
      num("resistance", t("Blast Resistance"), c, b.resistance, (v) => setB((x) => void (x.resistance = v)), { min: 0 }),
      text("sound", t("Sound"), c, b.sound, (v) => setB((x) => void (x.sound = v || undefined)), {
        suggestions: choices.sounds,
        description: t("One of the game's sound groups (stone, wood, metal, amethyst…) — or the mod's own, @sound_group:mymod:crystal (a .ydef)."),
      }),
      num("light", t("Light Level"), c, b.light, (v) => setB((x) => void (x.light = v)), { min: 0, max: 15, int: true }),
      text(
        "tool",
        pt("block", "Tool"),
        c,
        tools,
        (v) =>
          setB((x) => {
            const list = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
            x.tool = list.length === 0 ? undefined : list.length === 1 ? list[0] : list;
          }),
        { suggestions: TOOLS, description: t("pickaxe, axe, shovel, hoe — or a mod's tool tag, @tag:block:mymod:mineable/hammer; several separated by commas.") }
      ),
      text("tool_level", t("Tool Level"), c, b.tool_level, (v) => setB((x) => void (x.tool_level = v || undefined)), {
        suggestions: TOOL_LEVELS,
        description: t("wood, stone, iron, diamond, netherite — or a level of the tool ladder, @level:mymod:mythril (a .ydef)."),
      }),
      flag("requires_tool", t("Requires Tool"), c, b.requires_tool, (v) => setB((x) => void (x.requires_tool = v)), false, { description: t("Drops nothing unless mined with the right tool.") }),
      flag("collision", t("Collision"), c, b.collision, (v) => setB((x) => void (x.collision = v)), true),
      num("slipperiness", t("Slipperiness"), c, b.slipperiness, (v) => setB((x) => void (x.slipperiness = v)), { min: 0, max: 1, description: t("0.6 normal, 0.98 ice.") }),
      choice("render_layer", t("Render Layer"), c, b.render_layer, RENDER_LAYERS, (v) => setB((x) => void (x.render_layer = v)), {
        description: t("cutout for textures with fully transparent pixels, translucent for glass-like ones."),
      }),
      text(
        "shape",
        t("Shape"),
        c,
        Array.isArray(b.shape) ? vecText(b.shape) : b.shape,
        (v) =>
          setB((x) => {
            if (v === undefined || v === "auto" || v === "full") x.shape = v as "auto" | "full" | undefined;
            else {
              const r = parseVec(v, 6, 0, 16);
              if (typeof r !== "string") x.shape = r;
            }
          }),
        {
          suggestions: ["auto", "full"],
          validate: (v) => {
            const s = String(v).trim();
            if (s === "" || s === "auto" || s === "full") return null;
            const r = parseVec(s, 6, 0, 16);
            return typeof r === "string" ? t("auto, full or x1, y1, z1, x2, y2, z2") : null;
          },
          description: t("The outline/collision box: auto (the model's bounds), full, or x1, y1, z1, x2, y2, z2 in pixels."),
        }
      ),
      text(
        "drops",
        t("Drops"),
        c,
        drops,
        (v) =>
          setB((x) => {
            if (v === undefined || v === "self" || v === "none") x.drops = v as "self" | "none" | undefined;
            else x.drops = { ...(typeof x.drops === "object" ? x.drops : {}), item: v.startsWith("@") ? v : `@item:${v}` };
          }),
        { suggestions: ["self", "none"], description: t("self (default), none, or an item id.") }
      ),
      text(
        "connect_groups",
        t("Connects With"),
        c,
        b.connect_groups?.join(", "),
        (v) => setB((x) => void (x.connect_groups = v ? v.split(/[,\s]+/).filter(Boolean) : undefined)),
        { description: t("Groups of blocks this one connects to (with an arm model in States). Default: itself.") }
      ),
      text("inventory", t("Inventory"), c, b.inventory, (v) => setB((x) => void (x.inventory = v)), {
        description: t("The inventory screen it opens: the id of a .yui <Screen> with <Slot>s."),
      }),
      flag("accepts_items", t("Accepts Items"), c, b.accepts_items, (v) => setB((x) => void (x.accepts_items = v)), false, {
        description: t("Hoppers and droppers can put items into it; the mod takes what it wants (on_item_insert)."),
      }),
      flag("redstone", t("Redstone Source"), c, b.redstone, (v) => setB((x) => void (x.redstone = v)), false, {
        description: t("Gives off redstone power, set by the mod per position."),
      }),
      text("powered", t("Powered Property"), c, b.powered, (v) => setB((x) => void (x.powered = v)), {
        suggestions: yesNoProperties,
        description: t("A yes/no property of its states kept on while it gets redstone power."),
      }),
      text("comparator", t("Comparator Property"), c, b.comparator, (v) => setB((x) => void (x.comparator = v)), {
        suggestions: yesNoProperties,
        description: t("A yes/no property of its states a comparator reads: 15 while it's on."),
      }),
      flag("occludes", t("Occludes"), c, b.occludes, (v) => setB((x) => void (x.occludes = v)), blockKind?.occludes ?? true, {
        description: t("Hides block faces behind it and blocks light. The selected block kind supplies the default."),
      }),
      ...(blockKind?.takes.includes("base")
        ? [text("kind_base", t("Kind Base Block"), c, b.base, (v) => setB((x) => void (x.base = v)), {
            suggestions: refSuggestions(blockRefs, "block"),
            validate: (v) => refMessage(t, refProblem(String(v), "block", blockRefs), "block"),
            description: t("The block this kind is based on, as @block:namespace:id (for example, a stair or slab's material block)."),
          })]
        : []),
      ...(blockKind?.takes.includes("set")
        ? [text("kind_set", t("Kind Set"), c, b.set, (v) => setB((x) => void (x.set = v)), {
            description: t("The registered block set, such as oak, dark_oak, iron or stone. The game's set names are open-ended."),
          })]
        : []),
      ...(blockKind?.takes.includes("press_ticks")
        ? [num("press_ticks", t("Press Ticks"), c, b.press_ticks, (v) => setB((x) => void (x.press_ticks = v)), {
            min: 1,
            int: true,
            description: t("How long a pressed button stays active, in ticks (30 by default)."),
          })]
        : []),
      ...(blockKind?.takes.includes("triggered_by")
        ? [choice("triggered_by", t("Triggered By"), c, b.triggered_by ?? "everything", ["everything", "mobs"], (v) =>
            setB((x) => void (x.triggered_by = v === "everything" ? undefined : v as NonNullable<ContentFile["block"]>["triggered_by"])), {
            optionLabel: (value) => t(value === "mobs" ? "Mobs Only" : "Everything"),
            description: t("What can trigger a button or pressure plate: everything includes items and arrows; mobs means living entities only."),
          })]
        : [])
    );
    // Its item form: how it stacks, survives fire, burns.
    const ic = t("Item");
    const bi = file.item ?? {};
    const setBI = (edit: (i: NonNullable<ContentFile["item"]>) => void) =>
      update((d) => {
        d.item ??= {};
        edit(d.item);
        if (prune(d.item as Record<string, unknown>)) delete d.item;
      });
    out.push(
      num("item_stack_size", t("Stack Size"), ic, bi.stack_size, (v) => setBI((x) => void (x.stack_size = v)), { min: 1, max: 99, int: true, description: t("How many of its item stack (64 by default).") }),
      flag("item_fire_resistant", t("Fire Resistant"), ic, bi.fire_resistant, (v) => setBI((x) => void (x.fire_resistant = v)), false),
      num("item_fuel_ticks", t("Fuel Ticks"), ic, bi.fuel_ticks, (v) => setBI((x) => void (x.fuel_ticks = v)), { min: 1, int: true, description: t("Burn time in a furnace (coal: 1600).") })
    );
  } else {
    const c = t("Item");
    const it = file.item ?? {};
    const setI = (edit: (i: NonNullable<ContentFile["item"]>) => void) =>
      update((d) => {
        d.item ??= {};
        edit(d.item);
        if (prune(d.item as Record<string, unknown>)) delete d.item;
      });
    out.push(
      num("stack_size", t("Stack Size"), c, it.stack_size, (v) => setI((x) => void (x.stack_size = v)), { min: 1, max: 99, int: true }),
      num("durability", t("Durability"), c, it.durability, (v) => setI((x) => void (x.durability = v)), { min: 1, int: true }),
      flag("fire_resistant", t("Fire Resistant"), c, it.fire_resistant, (v) => setI((x) => void (x.fire_resistant = v)), false),
      num("fuel_ticks", t("Fuel Ticks"), c, it.fuel_ticks, (v) => setI((x) => void (x.fuel_ticks = v)), { min: 1, int: true, description: t("Burn time in a furnace (coal: 1600).") }),
      num("nutrition", t("Food: Nutrition"), c, it.food?.nutrition, (v) =>
        setI((x) => {
          if (v === undefined) delete x.food;
          else x.food = { ...(x.food ?? {}), nutrition: v };
        }), { min: 0, int: true }),
      num("saturation", t("Food: Saturation"), c, it.food?.saturation, (v) => setI((x) => void (x.food && (x.food.saturation = v))), { min: 0 }),
      flag("always_edible", t("Food: Always Edible"), c, it.food?.always_edible, (v) => setI((x) => void (x.food && (x.food.always_edible = v))), false),
      text("tool_kind", t("Tool: Kind"), c, it.tool?.kind, (v) =>
        setI((x) => {
          if (v === undefined) delete x.tool;
          else x.tool = { material: "iron", ...(x.tool ?? {}), kind: v };
        }), {
        suggestions: TOOL_KINDS,
        description: t("pickaxe, axe, shovel, hoe, sword — or a mod's kind by the blocks it mines, @tag:block:mymod:mineable/hammer."),
      }),
      ...(it.tool
        ? [
            text("tool_material", t("Tool: Material"), c, it.tool.material, (v) => setI((x) => void (x.tool && v && (x.tool.material = v))), {
              suggestions: choices.toolMaterials,
              description: t("The game's material (wood, stone, iron, diamond, gold, netherite) or the mod's, @tool_material:mymod:mythril (a .ydef)."),
            }),
            num("attack_damage", t("Tool: Attack Damage"), c, it.tool.attack_damage, (v) => setI((x) => void (x.tool && (x.tool.attack_damage = v))), {
              description: t("On top of the material's. Default: the kind's (sword 3, axe 6, shovel 1.5, pickaxe 1, hoe 0)."),
            }),
            num("attack_speed", t("Tool: Attack Speed"), c, it.tool.attack_speed, (v) => setI((x) => void (x.tool && (x.tool.attack_speed = v))), {
              description: t("Change of attack speed. Default: the kind's (sword -2.4, axe -3.1, shovel -3, pickaxe -2.8, hoe -1)."),
            }),
          ]
        : []),
      choice("armor_slot", t("Armor: Slot"), c, it.armor?.slot, ARMOR_SLOTS, (v) =>
        setI((x) => {
          if (v === undefined) delete x.armor;
          else x.armor = { material: "iron", ...(x.armor ?? {}), slot: v as ArmorSlot };
        }), { optionLabel: (o) => (o ? t(o) : "") }),
      ...(it.armor
        ? [
            text("armor_material", t("Armor: Material"), c, it.armor.material, (v) => setI((x) => void (x.armor && v && (x.armor.material = v))), {
              suggestions: choices.armorMaterials,
              description: t("The game's material (leather, chainmail, iron, gold, diamond, turtle, netherite) or the mod's, @armor_material:mymod:mythril (a .ydef)."),
            }),
          ]
        : []),
      choice("wearable", t("Wearable"), c, it.wearable, ARMOR_SLOTS, (v) => setI((x) => void (x.wearable = v as ArmorSlot | undefined)), {
        optionLabel: (o) => (o ? t(o) : ""),
        description: t("Worn in this slot without being armor (a monocle, a crown): right-click and dispensers put it on."),
      }),
      {
        id: "potion",
        name: t("Potion"),
        category: c,
        value: !!it.potion,
        kind: "bool",
        readOnly: ro,
        description: t("This .yitem defines a potion registry entry, not an extra bottle item. Brewing recipes are .yrecipe files."),
        onCommit: (v) => setI((x) => {
          if (v) x.potion ??= { effects: [] };
          else delete x.potion;
        }),
      },
      ...(it.potion
        ? [
            text("potion_name", t("Potion Name"), c, it.potion.name, (v) => setI((x) => {
              if (!x.potion) return;
              if (v) x.potion.name = v;
              else delete x.potion.name;
            }), { description: t("The translation suffix for item.minecraft.potion.effect.<name>. Defaults to this .yitem id's path.") }),
            {
              id: "potion_effects",
              name: "",
              category: t("Potion Effects"),
              value: null,
              kind: "custom",
              description: t("The mob effects this potion gives, in ticks (20 per second) and levels (0 is I)."),
              render: () => (
                <RowsEditor<PotionEffectRow>
                  rows={it.potion?.effects ?? []}
                  readOnly={ro}
                  blank={() => ({ effect: "@effect:minecraft:speed", duration: 3600, amplifier: 0 })}
                  onChange={(effects) => setI((x) => {
                    if (x.potion) {
                      x.potion.effects = effects.flatMap(({ effect, duration, amplifier }) =>
                        effect ? [{ effect, duration: duration ?? 3600, ...(amplifier === undefined ? {} : { amplifier }) }] : [],
                      );
                    }
                  })}
                  columns={[
                    { key: "effect", label: t("Effect"), kind: "text", grow: 3, suggestions: refSuggestions(effectRefs, "effect"), validate: (v) => refMessage(t, refProblem(v, "effect", effectRefs), "effect") },
                    { key: "duration", label: t("Ticks"), kind: "number", min: 1, int: true },
                    { key: "amplifier", label: t("Level"), kind: "number", min: 0, int: true, placeholder: "0" },
                  ]}
                />
              ),
            } satisfies PropertyDescriptor,
          ]
        : []),
      text("hangs_entity", t("Hanging Entity"), c, it.hangs?.entity, (v) =>
        setI((x) => {
          if (!v) delete x.hangs;
          else x.hangs = { ...(x.hangs ?? {}), entity: v };
        }), {
        suggestions: refSuggestions(entityRefs, "entity"),
        validate: (v) => refMessage(t, refProblem(String(v), "entity", entityRefs), "entity"),
        description: t("A hanging entity this item places, as @entity:namespace:id; it must have kind: hanging."),
      }),
      ...(it.hangs
        ? [vec("hangs_size", t("Hanging Size"), c, it.hangs.size, 2, (v) =>
            setI((x) => {
              if (!x.hangs) return;
              if (v) x.hangs.size = [v[0], v[1]];
              else delete x.hangs.size;
            }), 1, 4_294_967_295, true)]
        : [])
    );
  }
}
