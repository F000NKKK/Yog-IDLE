import { cli } from "../cli";
import { open } from "@tauri-apps/plugin-dialog";
import { confirmDialog, errorText, notify, promptDialog, reportError, showDialog, t } from "substrate-platform-ui";

// Project > Import…: blocks and items from a resource pack (a folder or a
// .zip — one model or all of them) or a Blockbench .bbmodel, into the mod's
// content/ as .yblock/.yitem files (`yog import`, see docs/blocks-items.md).

type Source = "pack-dir" | "pack-zip" | "bbmodel";

export async function importContent(modRoot: string): Promise<void> {
  const choice = await showDialog({
    title: t("Import Blocks and Items"),
    message: t(
      "Models of a resource pack (with their textures) or a Blockbench model become .yblock/.yitem files in content/, opened in the model editor."
    ),
    buttons: [
      { id: "cancel", label: t("Cancel") },
      { id: "pack-dir", label: t("Resource Pack Folder…") },
      { id: "pack-zip", label: t("Resource Pack .zip…") },
      { id: "bbmodel", label: t("Blockbench Model…"), variant: "primary" },
    ],
  });
  const source = choice.button as Source | "cancel";
  if (source === "cancel") return;

  const picked =
    source === "pack-dir"
      ? await open({ directory: true, title: t("Resource Pack Folder") })
      : await open({
          title: source === "pack-zip" ? t("Resource Pack") : t("Blockbench Model"),
          filters: source === "pack-zip" ? [{ name: t("Resource Packs"), extensions: ["zip"] }] : [{ name: t("Blockbench Models"), extensions: ["bbmodel"] }],
        });
  if (typeof picked !== "string") return;

  let kind: string;
  let model: string | null;
  if (source === "bbmodel") {
    const stem = (picked.split(/[\\/]/).pop() ?? "model").replace(/\.bbmodel$/i, "").toLowerCase().replace(/[^a-z0-9_]+/g, "_");
    model = await promptDialog({
      title: t("Import Blockbench Model"),
      label: t("Id"),
      defaultValue: stem,
      confirmLabel: t("Next"),
      validate: (v) => (/^([a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(v) ? null : t("Lowercase letters, digits, _ . - and /.")),
    });
    if (model === null) return;
    const as = await showDialog({
      title: t("Import Blockbench Model"),
      message: t("Import {name} as a block or as an item?", { name: model }),
      buttons: [
        { id: "cancel", label: t("Cancel") },
        { id: "item", label: t("Item") },
        { id: "block", label: t("Block"), variant: "primary" },
      ],
    });
    if (as.button === "cancel") return;
    kind = as.button === "item" ? "bbmodel-item" : "bbmodel";
  } else {
    kind = "resourcepack";
    model = await promptDialog({
      title: t("Import from Resource Pack"),
      message: t("A model id (mymod:block/ruby_ore, mymod:item/ruby), or empty for every block and item of the pack."),
      label: t("Model"),
      placeholder: t("All models"),
      confirmLabel: t("Import"),
    });
    if (model === null) return;
  }

  const path = `${modRoot.replace(/[/\\]+$/, "")}/yog.toml`;
  const run = (force: boolean) => cli<string>("content_import", { path, kind, source: picked, model: model || null, force });
  try {
    let out: string;
    try {
      out = await run(false);
    } catch (e) {
      if (!/already exists/.test(String(e))) throw e;
      const overwrite = await confirmDialog({
        title: t("Import Blocks and Items"),
        message: `${String(e)}\n\n${t("Overwrite the existing files?")}`,
        confirmLabel: t("Overwrite"),
      });
      if (!overwrite) return;
      out = await run(true);
    }
    notify({ level: "info", message: out || t("Imported.") });
  } catch (e) {
    reportError(t("Import failed: {error}", { error: String(e) }));
  }
}
