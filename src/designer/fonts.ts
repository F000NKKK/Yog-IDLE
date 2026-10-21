// Fonts as screens name them: a Yog font of the mod, or one of the game's
// by Yog's alias (`yog:font/alt`) — never the game's own id. Editing a
// game font edits the mod's copy of it (`content/font/<name>.yfont`).

import { fileNameOf, openFile, reportError, t, type PropertyDescriptor } from "substrate-platform-ui";
import { cli } from "../cli";
import { gameFont, serveMethod, yog } from "../data/yogIds.generated";
import { GAME_NAMESPACE, idParts } from "../data/yogFormat";

/** The game's fonts, by Yog's alias. */
export const GAME_FONTS: readonly string[] = Object.values(gameFont).map((name) => `${yog.FONT_ALIAS}${name}`);

/** Whether `font` is Yog's alias of a game font. */
export const isGameFontAlias = (font: string): boolean => font.startsWith(yog.FONT_ALIAS) && font.length > yog.FONT_ALIAS.length;

/** The problem with `font` if it names a game font directly (`yog ui gen` rejects it too). */
export function gameFontNamedDirectly(font: string): string | null {
  const [ns, name] = idParts(font);
  return ns === GAME_NAMESPACE ? t("The game's fonts are named by Yog's alias: {alias}", { alias: `${yog.FONT_ALIAS}${name}` }) : null;
}

interface FontCopy {
  id: string;
  file: string;
}

/** The mod's copy of game font `alias` (made if it has none), opened; resolves with its id. */
export async function editGameFont(path: string, alias: string): Promise<string> {
  const copy = await cli<FontCopy>(serveMethod.FONT_COPY, { path, alias });
  openFile({ path: copy.file, name: fileNameOf(copy.file) });
  return copy.id;
}

/** A Font row showing a game font: "…" edits the mod's copy of it and uses that (`use` sets the attribute). */
export function offerFontCopy(row: PropertyDescriptor, yuiPath: string, shown: string, use: (id: string) => void): void {
  const font = shown || yog.DEFAULT_FONT;
  if (!isGameFontAlias(font)) return;
  row.edit = () => void editGameFont(yuiPath, font).then(use, (e) => reportError(String(e)));
  row.description = `${row.description}\n\n${t("… copies the game's font into the mod (content/font/) to edit, and uses the copy.")}`;
}
