import { jsonLanguage, registerFileTypes } from "substrate-platform-ui";
import "./content/icons";
import { fileTypeId, formats } from "./yogFileTypes";
import { GAME_NAMESPACE } from "./data/yogFormat";

/** The game's language files (`lang/<locale>.json`): their file type. */
export const LANG_FILE_TYPE = `${GAME_NAMESPACE}.lang`;

// Yog's formats and the Minecraft files the IDE knows — the one place each
// is named and recognised; editors (`editors/index.tsx`) open them by id.

/** A resource pack's translations: `assets/<ns>/lang/<locale>.json`. */
function isLangFile(path: string): boolean {
  return /[\\/]assets[\\/][^\\/]+[\\/]lang[\\/][^\\/]+\.json$/i.test(path);
}

registerFileTypes([
  { id: LANG_FILE_TYPE, name: "Minecraft Language", extensions: ["json"], match: isLangFile, language: jsonLanguage },
  { id: `${LANG_FILE_TYPE}.legacy`, name: "Minecraft Language", extensions: ["lang"] },
  { id: fileTypeId(formats.ui), name: "Yog Screen", extensions: [formats.ui.ext], icon: "window" },
  { id: fileTypeId(formats.res), name: "Yog Resources", extensions: [formats.res.ext], icon: "table", language: jsonLanguage },
  { id: fileTypeId(formats.block), name: "Yog Block", extensions: [formats.block.ext], icon: "yogBlock", language: jsonLanguage },
  { id: fileTypeId(formats.item), name: "Yog Item", extensions: [formats.item.ext], icon: "yogItem", language: jsonLanguage },
  { id: fileTypeId(formats.recipe), name: "Yog Recipe", extensions: [formats.recipe.ext], language: jsonLanguage },
  { id: fileTypeId(formats.book), name: "Yog Book", extensions: [formats.book.ext], icon: "yogBook", language: jsonLanguage },
  { id: fileTypeId(formats.def), name: "Yog Definition", extensions: [formats.def.ext], icon: "yogDef", language: jsonLanguage },
  { id: fileTypeId(formats.model), name: "Yog Body Model", extensions: [formats.model.ext], icon: "yogBlock", language: jsonLanguage },
  { id: fileTypeId(formats.anim), name: "Yog Animations", extensions: [formats.anim.ext], icon: "yogAnim", language: jsonLanguage },
  { id: fileTypeId(formats.entity), name: "Yog Entity", extensions: [formats.entity.ext], icon: "yogEntity", language: jsonLanguage },
  { id: fileTypeId(formats.texture), name: "Yog Texture", extensions: [formats.texture.ext], icon: "yogTexture", language: jsonLanguage },
  { id: fileTypeId(formats.particle), name: "Yog Particle", extensions: [formats.particle.ext], icon: "yogParticle", language: jsonLanguage },
  { id: fileTypeId(formats.sound), name: "Yog Sound Event", extensions: [formats.sound.ext], icon: "yogSound", language: jsonLanguage },
  { id: fileTypeId(formats.video), name: "Yog Video", extensions: [formats.video.ext], icon: "yogVideo", language: jsonLanguage },
  { id: fileTypeId(formats.data), name: "Compiled Yog Data", extensions: [formats.data.ext] },
]);


