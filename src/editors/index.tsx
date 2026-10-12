import { registerEditorProvider } from "substrate-platform-ui";
import { isLangFile, LangFileEditor } from "./LangFileEditor";

// Yog-specific editors, on top of the platform's built-in ones — imported
// once for its side effect, before any file opens.

registerEditorProvider({
  id: "yog.lang",
  label: "Translations",
  extensions: ["json"],
  match: isLangFile,
  component: LangFileEditor,
  priority: 10,
  kind: "designer",
});
