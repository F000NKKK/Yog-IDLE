import { JsonEditor, registerEditorProvider } from "substrate-platform-ui";
import "../content/icons";
import { ScreenDesigner } from "../designer/ScreenDesigner";
import { YuiSourceEditor, YuiSplitEditor } from "../designer/YuiSplitEditor";
import { CONTENT_SOURCE_VIEW, ContentEditor } from "./ContentEditor";
import { isLangFile, LangFileEditor } from "./LangFileEditor";
import { YRES_SOURCE_VIEW, YresEditor } from "./YresEditor";

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

// `.yui` screens, as Visual Studio shows XAML: Design and XAML split in one
// tab by default, either one alone a click away. (The split view keeps the
// id the designer used to have, so a remembered "designer" choice becomes it.)
registerEditorProvider({
  id: "yog.yui",
  label: "Design and XAML",
  name: "Screen Designer",
  icon: "splitRows",
  extensions: ["yui"],
  component: YuiSplitEditor,
  priority: 20,
  kind: "text",
  strict: true,
});

registerEditorProvider({
  id: "yog.yui.design",
  label: "Designer",
  name: "Screen Designer (Design Only)",
  extensions: ["yui"],
  component: ScreenDesigner,
  priority: 10,
  kind: "designer",
});

registerEditorProvider({
  id: "yog.yui.source",
  label: "XAML",
  name: "Screen Source Editor",
  extensions: ["yui"],
  component: YuiSourceEditor,
  priority: 0,
  kind: "text",
});

// `.yres` resource files, as Visual Studio opens `.resx`: the resource table
// by default, the JSON a click (or F7) away.
registerEditorProvider({
  id: "yog.yres",
  label: "Resources",
  name: "Resource Editor",
  icon: "table",
  extensions: ["yres"],
  component: YresEditor,
  priority: 20,
  kind: "designer",
});

registerEditorProvider({
  id: YRES_SOURCE_VIEW,
  label: "Code",
  name: "Resource Source Editor",
  extensions: ["yres"],
  component: JsonEditor,
  priority: 0,
  kind: "text",
});

// `.yblock` / `.yitem` blocks and items: the 3D model editor by default, the
// JSON a click (or F7) away.
registerEditorProvider({
  id: "yog.content",
  label: "Model",
  name: "Block/Item Editor",
  icon: "yogBlock",
  extensions: ["yblock", "yitem"],
  component: ContentEditor,
  priority: 20,
  kind: "designer",
});

registerEditorProvider({
  id: CONTENT_SOURCE_VIEW,
  label: "Code",
  name: "Block/Item Source Editor",
  extensions: ["yblock", "yitem"],
  component: JsonEditor,
  priority: 0,
  kind: "text",
});
