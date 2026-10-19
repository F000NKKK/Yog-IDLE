// General: id, name, tooltip, registration, tags, required mods.

import { type PropertyDescriptor, t } from "substrate-platform-ui";
import type { ContentFile } from "../../../content/model";
import type { PropertiesContext } from "./context";

/** General: id, name, tooltip, registration, tags, required mods. */
export function generalRows(ctx: PropertiesContext, out: PropertyDescriptor[]): void {
  const { file, kind, update, choices, text, choice, list } = ctx;
  // General.
  const general = t("General");
  out.push(
    text("id", t("Id"), general, file.id, (v) => update((d) => void (d.id = v)), {
      description: t("The registry id — `namespace:name`, or just `name` (the mod's namespace). Default: the file name."),
    }),
    text("name", t("Name"), general, file.name, (v) => update((d) => void (d.name = v)), {
      suggestions: choices.strings,
      description: t("Display name — a literal English text or a `@Set.name` text of a .yres file (translated)."),
    }),
    text("tooltip", t("Tooltip"), general, file.tooltip, (v) => update((d) => void (d.tooltip = v)), {
      suggestions: choices.strings,
      description: t("A line under the name — literal or `@Set.name`."),
    }),
    choice("register", t("Registration"), general, file.register, ["auto", "manual"], (v) => update((d) => void (d.register = v as ContentFile["register"])), {
      description: t("auto: registered by yog_api::content!(); manual: you register Blocks::x() / Items::x() yourself (to add behavior)."),
    }),
    list("tags", t("Tags"), general, file.tags, (v) => update((d) => void (d.tags = v)), {
      suggestions: choices.tags,
      description:
        kind === "block"
          ? t("Tags it's in, comma-separated: Yog's common tags (yog:logs — the game's or each loader's tag of that meaning), the game's (minecraft:logs) or the mod's own by name. A block joins the block tag and its item the item tag.")
          : t("Tags it's in, comma-separated: Yog's common tags (yog:ingots/iron — the game's or each loader's tag of that meaning), the game's (minecraft:planks) or the mod's own by name."),
    }),
    list("requires", t("Requires Mods"), general, file.requires, (v) => update((d) => void (d.requires = v)), {
      description: t("Mods it needs, comma-separated — Yog or Java mod ids (pehkui): without every one of them loaded it isn't there."),
    })
  );
}
