import { registerEditorProvider, XmlEditor } from "substrate-platform-ui";
import { ScreenDesigner } from "../designer/ScreenDesigner";
import { isLangFile, LangFileEditor } from "./LangFileEditor";

// Yog-specific editors, on top of the platform's built-in ones — imported
// once for its side effect, before any file opens.

registerEditorProvider({
  id: "yog.lang",
  label: "Translations",
  name: "Translations Designer",
  extensions: ["json"],
  match: isLangFile,
  component: LangFileEditor,
  priority: 10,
  kind: "designer",
});

// `.yui` screens: the designer by default, the XML underneath as "Source".
registerEditorProvider({
  id: "yog.yui",
  label: "Designer",
  name: "Screen Designer",
  extensions: ["yui"],
  component: ScreenDesigner,
  priority: 10,
  kind: "designer",
});

registerEditorProvider({
  id: "yog.yui.source",
  label: "Source",
  name: "Screen Source Editor",
  extensions: ["yui"],
  component: XmlEditor,
  priority: 0,
  kind: "text",
});
