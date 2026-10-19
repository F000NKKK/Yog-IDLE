// A block's states: its properties and variants, how it's placed, and what's picked in the outliner.

import { type PropertyDescriptor, t } from "substrate-platform-ui";
import { type ContentFile, FACING_LABELS, FACINGS, PLACEMENTS } from "../../../content/model";
import { isWord, modelNames, modelNamesValue, parseVariantKey, PROPERTY_KIND_LABELS, PROPERTY_KINDS, propertyKind, type PropertyKind, propertyNameProblem, rangeValues, renameModel, renameProperty, setVariantKey, stateCount, statesShowing, valuesProblem, variantKey, variantProblems, withDefault, YES_NO } from "../../../content/states";
import { ARM_TEMPLATE, stateModelKey } from "../contentModel";
import { parseRotations, rotationsText } from "../fieldText";
import type { PropertiesContext } from "./context";

/** A block's states: its properties and variants, how it's placed, and what's picked in the outliner. */
export function stateRows(ctx: PropertiesContext, out: PropertyDescriptor[]): void {
  const { file, kind, update, editStates, effectiveKey, modelKey, mainResolved, pickedState, setModelKey, setPreviewState, setStateSel, stateModelNames, stateProps, states, num, text, choice, flag, list, prune } = ctx;
  const ro = ctx.readOnly;
  // States.
  if (kind === "block") {
    const c = t("States");
    out.push(
      text(
        "rotations",
        t("Random Rotations"),
        c,
        rotationsText(file.states?.rotations),
        (v) =>
          update((d) => {
            const r = v ? parseRotations(v) : [];
            if (typeof r === "string") return;
            d.states ??= {};
            d.states.rotations = r.length ? r : undefined;
            if (prune(d.states as Record<string, unknown>)) delete d.states;
          }),
        {
          suggestions: ["0,0; 0,90; 0,180; 0,270", "0,0; 90,0; 180,0; 270,0; 0,90; 0,270"],
          validate: (v) => {
            const r = String(v).trim() ? parseRotations(String(v)) : [];
            return typeof r === "string" ? t(r) : null;
          },
          description: t("Variants picked at random per position (x,y in degrees, *weight) — like stone's. The toolbar previews each."),
        }
      ),
      {
        id: "connects",
        name: t("Connects"),
        category: c,
        value: !!file.states?.connect,
        kind: "bool",
        readOnly: ro,
        description: t("Adds an arm model drawn towards each neighbor it connects to (fences, pipes)."),
        onCommit: (v) =>
          update((d) => {
            if (v) {
              d.states ??= {};
              d.states.connect ??= { arm: ARM_TEMPLATE(mainResolved.textures[mainResolved.slots[0]] ?? "minecraft:block/stone") };
            } else if (d.states) {
              delete d.states.connect;
              if (prune(d.states as Record<string, unknown>)) delete d.states;
              if (modelKey === "arm") setModelKey("model");
            }
          }),
      },
      ...(file.states?.connect
        ? [flag("arm_uvlock", t("Arm UV Lock"), c, file.states.connect.uvlock, (v) => update((d) => void (d.states!.connect!.uvlock = v)), false)]
        : [])
    );
  }

  // How it's placed.
  if (kind === "block") {
    const c = t("States");
    const st = file.states ?? {};
    const setS = (edit: (s: NonNullable<ContentFile["states"]>) => void) =>
      update((d) => {
        d.states ??= {};
        edit(d.states);
        if (prune(d.states as Record<string, unknown>)) delete d.states;
      });
    out.push(
      choice("facing", t("Facing"), c, st.facing, FACINGS, (v) => setS((x) => void (x.facing = v as typeof st.facing)), {
        optionLabel: (o) => (o ? t(FACING_LABELS[o as keyof typeof FACING_LABELS]) : ""),
        description: t("The block turns when placed (a facing property); its model's north side is its front."),
      }),
      choice("placement", t("Placement"), c, st.placement, PLACEMENTS, (v) => setS((x) => void (x.placement = v as typeof st.placement)), {
        optionLabel: (o) => (o ? t(o) : ""),
        description: t("toward: its front faces the player (a furnace, the default); away: the way they look (an observer)."),
      }),
      flag("attach", t("Attaches"), c, st.attach, (v) => setS((x) => void (x.attach = v)), false, {
        description: t("Hangs on a floor, wall or ceiling, as a button does; its model lies on the floor."),
      }),
      flag("waterlogged", t("Waterloggable"), c, st.waterlogged, (v) => setS((x) => void (x.waterlogged = v)), false, {
        description: t("It can stand in water."),
      }),
      flag("states_uvlock", t("UV Lock"), c, st.uvlock, (v) => setS((x) => void (x.uvlock = v)), false, {
        description: t("Its textures stay as they are in the world when it turns."),
      })
    );
  }

  // The property, state model or variant picked in the outliner.
  if (kind === "block" && pickedState && states) {
    const key = pickedState.key;
    if (pickedState.kind === "property") {
      const c = `${t("State Property")}: ${key}`;
      const values = states.properties![key];
      const pk = propertyKind(values);
      const setValues = (next: string[]) => editStates((st) => void (st.properties![key] = next));
      const nums = values.map(Number);
      const min = Math.min(...nums);
      const max = Math.max(...nums);
      out.push(
        text("sp.name", t("Name"), c, key, (v) => {
          if (!v || v === key) return;
          editStates((st, d) => renameProperty(st, d.block, key, v));
          setStateSel({ kind: "property", key: v });
        }, {
          validate: (v) => {
            const name = String(v).trim();
            const problem = name === key ? null : propertyNameProblem(name, stateProps.map((p) => p.name));
            return problem && t(problem);
          },
          description: t("Renaming it renames it in the variants and in Powered/Comparator Property too."),
        }),
        {
          id: "sp.kind",
          name: t("Kind"),
          category: c,
          value: pk,
          kind: "enum",
          options: PROPERTY_KINDS,
          optionLabel: (o) => t(PROPERTY_KIND_LABELS[o as PropertyKind]),
          readOnly: ro,
          description: t("Yes/No: false, true. Number Range: whole numbers from one to another. Values: names of your own."),
          onCommit: (v) => {
            if (v === pk) return;
            if (v === "bool") setValues([...YES_NO]);
            else if (v === "range") setValues(rangeValues(0, Math.max(1, values.length - 1)));
            else setValues(pk === "bool" ? ["off", "on"] : values.map((x) => `n${x}`));
          },
        }
      );
      if (pk === "range") {
        out.push(
          num("sp.min", t("Minimum"), c, min, (v) => v !== undefined && v < max && setValues(rangeValues(v, max, values[0])), { min: 0, max: max - 1, int: true }),
          num("sp.max", t("Maximum"), c, max, (v) => v !== undefined && v > min && setValues(rangeValues(min, v, values[0])), { min: min + 1, int: true })
        );
      } else if (pk === "values") {
        out.push(
          text("sp.values", t("Values"), c, values.join(", "), (v) => {
            const next = (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
            if (!valuesProblem(next)) setValues(next);
          }, {
            validate: (v) => {
              const problem = valuesProblem(String(v).split(",").map((x) => x.trim()).filter(Boolean));
              return problem && t(problem);
            },
            description: t("Its values, comma-separated: lowercase letters, digits and _. The first is the default."),
          })
        );
      }
      out.push({
        id: "sp.default",
        name: t("Default"),
        category: c,
        value: values[0],
        kind: "enum",
        options: pk === "range" ? [...values].sort((a, b) => Number(a) - Number(b)) : values,
        readOnly: ro,
        description: pk === "bool" ? t("The value a placed block starts with. Powered and Comparator Property need false.") : t("The value a placed block starts with."),
        onCommit: (v) => setValues(withDefault(values, String(v))),
      });
    } else if (pickedState.kind === "model") {
      const c = `${t("State Model")}: ${key}`;
      const users = Object.entries(states.variants ?? {})
        .filter(([, v]) => modelNames(v).includes(key))
        .map(([k]) => k || t("Every state"));
      out.push(
        text("sm.name", t("Name"), c, key, (v) => {
          if (!v || v === key) return;
          editStates((st) => renameModel(st, key, v));
          setStateSel({ kind: "model", key: v });
          if (effectiveKey === stateModelKey(key)) setModelKey(stateModelKey(v));
        }, {
          validate: (v) => {
            const name = String(v).trim();
            if (name === key) return null;
            return !isWord(name) ? t("Lowercase letters, digits and _.") : stateModelNames.includes(name) ? t("The block already has a model of this name.") : null;
          },
          description: t("Renaming it renames it in the variants too."),
        }),
        {
          id: "sm.users",
          name: t("Used By"),
          category: c,
          value: users.join("; ") || t("No variant — add one that picks it."),
          kind: "string",
          readOnly: true,
        }
      );
    } else {
      const c = t("Variant");
      const when = Object.fromEntries(parseVariantKey(key));
      const problems = variantProblems(states, key);
      const setWhen = (name: string, value: string | undefined): string | void => {
        const next = variantKey({ ...when, [name]: value ?? "" }, stateProps);
        if (next === key) return;
        if (states.variants && next in states.variants) return t("Another variant has these conditions.");
        editStates((st) => void setVariantKey(st, key, next));
        setStateSel({ kind: "variant", key: next });
        setPreviewState(Object.fromEntries(parseVariantKey(next)));
      };
      for (const p of stateProps) {
        out.push({
          id: `sv.when.${p.name}`,
          name: p.name,
          category: c,
          value: when[p.name] ?? "",
          kind: "enum",
          options: ["", ...p.values],
          optionLabel: (o) => (o ? o : t("Any")),
          readOnly: ro,
          description: t("The value the state must have for this variant to show — Any: whatever it is."),
          onCommit: (v) => setWhen(p.name, String(v) || undefined),
        });
      }
      out.push(
        list("sv.models", t("Models"), c, modelNames(states.variants![key]), (v) => {
          if (v?.length) editStates((st) => void (st.variants![key] = modelNamesValue(v)));
        }, {
          suggestions: stateModelNames,
          validate: (v) => {
            const names = String(v).split(",").map((x) => x.trim()).filter(Boolean);
            if (!names.length) return t("A model name, or a list of them.");
            const missing = names.find((n) => !states.models?.[n]);
            return missing ? t("{name}: not in the state models", { name: missing }) : null;
          },
          description: t("The state model it shows; several, comma-separated, are picked at random per position. Turning for Facing and Attaches is added."),
        }),
        {
          id: "sv.shown",
          name: t("Shown For"),
          category: c,
          value: t("{n} of {total} states", { n: statesShowing(states, key), total: stateCount(stateProps) }),
          kind: "string",
          readOnly: true,
          description: t("The states it's the first match for — a variant above it that matches too wins."),
        }
      );
      if (problems.length) {
        out.push({
          id: "sv.problems",
          name: t("Problems"),
          category: c,
          value: problems.map((x) => t(x.message, x.params)).join("; "),
          kind: "string",
          readOnly: true,
        });
      }
    }
  }
}
