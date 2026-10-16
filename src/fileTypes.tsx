import { jsonLanguage, registerFileTypes } from "substrate-platform-ui";
import "./content/icons";

// Yog's formats and the Minecraft files the IDE knows — the one place each
// is named and recognised; editors (`editors/index.tsx`) open them by id.

/** A resource pack's translations: `assets/<ns>/lang/<locale>.json`. */
function isLangFile(path: string): boolean {
  return /[\\/]assets[\\/][^\\/]+[\\/]lang[\\/][^\\/]+\.json$/i.test(path);
}

registerFileTypes([
  { id: "minecraft.lang", name: "Minecraft Language", extensions: ["json"], match: isLangFile, language: jsonLanguage },
  { id: "minecraft.lang.legacy", name: "Minecraft Language", extensions: ["lang"] },
  { id: "yog.yui", name: "Yog Screen", extensions: ["yui"], icon: "window" },
  { id: "yog.yres", name: "Yog Resources", extensions: ["yres"], icon: "table", language: jsonLanguage },
  { id: "yog.yblock", name: "Yog Block", extensions: ["yblock"], icon: "yogBlock", language: jsonLanguage },
  { id: "yog.yitem", name: "Yog Item", extensions: ["yitem"], icon: "yogItem", language: jsonLanguage },
  { id: "yog.yrecipe", name: "Yog Recipe", extensions: ["yrecipe"], language: jsonLanguage },
  { id: "yog.ybook", name: "Yog Book", extensions: ["ybook"], icon: "yogBook", language: jsonLanguage },
  { id: "yog.ydef", name: "Yog Definition", extensions: ["ydef"], icon: "yogDef", language: jsonLanguage },
  { id: "yog.ylayout", name: "Yog Recipe Layout", extensions: ["ylayout"], language: jsonLanguage },
  { id: "yog.ymodel", name: "Yog Body Model", extensions: ["ymodel"], icon: "yogBlock", language: jsonLanguage },
  { id: "yog.yanim", name: "Yog Animations", extensions: ["yanim"], icon: "yogAnim", language: jsonLanguage },
  { id: "yog.yentity", name: "Yog Entity", extensions: ["yentity"], icon: "yogEntity", language: jsonLanguage },
  { id: "yog.ydata", name: "Compiled Yog Data", extensions: ["ydata"] },
]);


