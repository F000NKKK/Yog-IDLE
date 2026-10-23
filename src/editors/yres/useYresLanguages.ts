// Adding a language, showing every language, picking a file for a value.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { promptDialog, reportError } from "substrate-platform-ui";
import { cli } from "../../cli";
import { resKind, serveMethod } from "../../data/yogIds.generated";
import { files } from "../../files";
import { isLocaleName, NEUTRAL_LOCALE, serializeYres, type YresEntry, yresFileName } from "../../lang/yres";
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "../MediaValue";
import type { YresFile } from "./useYresFile";
import type { YresSiblings } from "./useYresSiblings";
import { type Row, SHOW_ALL_KEY } from "./yresModel";

/** Adding a language, showing every language, picking a file for a value. */
export function useYresLanguages(yresFile: YresFile, yresSiblings: YresSiblings) {
  const { t, entries, dir, set, ownLocale, sep, isCulture, setShowAll, siblings } = yresFile;
  const { loadSiblings, neutral } = yresSiblings;
  async function addLanguage() {
    const taken = new Set<string>([NEUTRAL_LOCALE, ...siblings.map((s) => s.locale ?? NEUTRAL_LOCALE)]);
    if (ownLocale) taken.add(ownLocale);
    const name = await promptDialog({
      title: t("Add Language"),
      message: t("A new {file} next to this one, with every text of the set left to translate.", { file: yresFileName(set, "<locale>") }),
      label: t("Locale"),
      placeholder: "ru_ru",
      confirmLabel: t("Add"),
      validate: (value) => {
        const v = value.trim().toLowerCase();
        if (!v) return "";
        if (!isLocaleName(v)) return t("A Minecraft locale code, like ru_ru, de_de or pt_br.");
        if (v === NEUTRAL_LOCALE) return t("The neutral file {file} already holds the {locale} texts.", { file: yresFileName(set, null), locale: NEUTRAL_LOCALE });
        if (taken.has(v)) return t("This folder already has {name}.", { name: yresFileName(set, v) });
        return null;
      },
    });
    if (!name) return;
    const target = `${dir}${sep}${yresFileName(set, name.trim().toLowerCase())}`;
    const source = isCulture ? (neutral?.entries ?? []) : entries;
    const seen = new Set<string>();
    const texts = source
      .filter((e) => e.type === resKind.STRING && e.name && !seen.has(e.name) && seen.add(e.name))
      .map((e): YresEntry => ({ name: e.name, type: resKind.STRING, value: "" }));
    try {
      await files.write(target, await serializeYres(texts));
    } catch (err) {
      reportError(t("Failed to save {path}: {error}", { path: target, error: String(err) }));
      return;
    }
    setShowAll(true);
    localStorage.setItem(SHOW_ALL_KEY, "1");
    void loadSiblings();
  }

  function toggleShowAll() {
    setShowAll((v) => {
      localStorage.setItem(SHOW_ALL_KEY, v ? "0" : "1");
      return !v;
    });
  }

  /** A file picked from disk, taken into the entry by the CLI (`media.import`): its `@bytes:` value. */
  async function pickFile(row: Row): Promise<string | null> {
    const filters =
      row.type === resKind.IMAGE
        ? [{ name: t("Images"), extensions: IMAGE_EXTENSIONS }]
        : row.type === resKind.SOUND
          ? [{ name: t("Ogg Vorbis Sounds"), extensions: ["ogg"] }]
          : row.type === resKind.VIDEO
            ? [{ name: t("Videos"), extensions: VIDEO_EXTENSIONS }]
            : undefined;
    const picked = await openDialog({ defaultPath: dir, multiple: false, directory: false, filters });
    if (typeof picked !== "string") return null;
    try {
      return (await cli<{ value: string }>(serveMethod.MEDIA_IMPORT, { file: picked })).value;
    } catch (err) {
      reportError(String(err));
      return null;
    }
  }

  return { addLanguage, toggleShowAll, pickFile };
}

/** What `useYresLanguages` gives the component. */
export type YresLanguages = ReturnType<typeof useYresLanguages>;
