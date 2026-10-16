import { JsonEditor, registerEditorProvider } from "substrate-platform-ui";
import "../fileTypes";
import { ScreenDesigner } from "../designer/ScreenDesigner";
import { YuiSourceEditor, YuiSplitEditor } from "../designer/YuiSplitEditor";
import { CONTENT_SOURCE_VIEW, ContentEditor } from "./ContentEditor";
import { LangFileEditor } from "./LangFileEditor";
import { BOOK_SOURCE_VIEW, BookEditor } from "./BookEditor";
import { RECIPE_SOURCE_VIEW, RecipeEditor } from "./RecipeEditor";
import { YRES_SOURCE_VIEW, YresEditor } from "./YresEditor";
import { DataEditor } from "./DataEditor";
import { YdataViewer } from "./YdataViewer";
import { MODEL_SOURCE_VIEW, ModelEditor } from "./ModelEditor";
import { ENTITY_SOURCE_VIEW, EntityEditor } from "./EntityEditor";
import type { EditorProps } from "substrate-platform-ui";

// Yog-specific editors, on top of the platform's built-in ones — imported
// once for its side effect, before any file opens.

registerEditorProvider({
  id: "yog.lang",
  label: "Translations",
  name: "Translations Designer",
  fileTypes: ["minecraft.lang"],
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
  fileTypes: ["yog.yui"],
  component: YuiSplitEditor,
  priority: 20,
  kind: "text",
  strict: true,
});

registerEditorProvider({
  id: "yog.yui.design",
  label: "Designer",
  name: "Screen Designer (Design Only)",
  fileTypes: ["yog.yui"],
  component: ScreenDesigner,
  priority: 10,
  kind: "designer",
});

registerEditorProvider({
  id: "yog.yui.source",
  label: "XAML",
  name: "Screen Source Editor",
  fileTypes: ["yog.yui"],
  component: YuiSourceEditor,
  priority: 0,
  kind: "text",
    // The JSON/XAML of this format only — other files have the general editors.
    strict: true,
});

// `.yres` resource files, as Visual Studio opens `.resx`: the resource table
// by default, the JSON a click (or F7) away.
registerEditorProvider({
  id: "yog.yres",
  label: "Resources",
  name: "Resource Editor",
  icon: "table",
  fileTypes: ["yog.yres"],
  component: YresEditor,
  priority: 20,
  kind: "designer",
});

registerEditorProvider({
  id: YRES_SOURCE_VIEW,
  label: "Code",
  name: "Resource Source Editor",
  fileTypes: ["yog.yres"],
  component: JsonEditor,
  priority: 0,
  kind: "text",
    // The JSON/XAML of this format only — other files have the general editors.
    strict: true,
});

// `.yblock` / `.yitem` blocks and items: the 3D model editor by default, the
// JSON a click (or F7) away.
registerEditorProvider({
  id: "yog.content",
  label: "Model",
  name: "Block/Item Editor",
  icon: "yogBlock",
  fileTypes: ["yog.yblock", "yog.yitem"],
  component: ContentEditor,
  priority: 20,
  kind: "designer",
});

registerEditorProvider({
  id: CONTENT_SOURCE_VIEW,
  label: "Code",
  name: "Block/Item Source Editor",
  fileTypes: ["yog.yblock", "yog.yitem"],
  component: JsonEditor,
  priority: 0,
  kind: "text",
    // The JSON/XAML of this format only — other files have the general editors.
    strict: true,
});

// `.yrecipe` recipes: a crafting table by default, the JSON a click away.
registerEditorProvider({
  id: "yog.recipe",
  label: "Recipe",
  name: "Recipe Editor",
  icon: "table",
  fileTypes: ["yog.yrecipe"],
  component: RecipeEditor,
  priority: 20,
  kind: "designer",
});

registerEditorProvider({
  id: RECIPE_SOURCE_VIEW,
  label: "Code",
  name: "Recipe Source Editor",
  fileTypes: ["yog.yrecipe"],
  component: JsonEditor,
  priority: 0,
  kind: "text",
    // The JSON/XAML of this format only — other files have the general editors.
    strict: true,
});

// `.ybook` guide books: the book itself, live, by default; the JSON a click away.
registerEditorProvider({
  id: "yog.book",
  label: "Book",
  name: "Book Designer",
  icon: "yogBook",
  fileTypes: ["yog.ybook"],
  component: BookEditor,
  priority: 20,
  kind: "designer",
});

registerEditorProvider({
  id: BOOK_SOURCE_VIEW,
  label: "Code",
  name: "Book Source Editor",
  fileTypes: ["yog.ybook"],
  component: JsonEditor,
  priority: 0,
  kind: "text",
    // The JSON/XAML of this format only — other files have the general editors.
    strict: true,
});

// Formats without a designer of their own — `.ydef` definitions, `.ylayout`
// recipe layouts: a property grid generated from the build's schema, the
// code a click away.
for (const [format, name] of [
  ["ydef", "Definition"],
  ["ylayout", "Recipe Layout"],
] as const) {
  const sourceView = `yog.${format}.source`;
  registerEditorProvider({
    id: `yog.${format}`,
    label: "Properties",
    name: `${name} Editor`,
    icon: "table",
    fileTypes: [`yog.${format}`],
    component: (props: EditorProps) => <DataEditor {...props} format={format} sourceView={sourceView} />,
    priority: 20,
    kind: "designer",
  });
  registerEditorProvider({
    id: sourceView,
    label: "Code",
    name: `${name} Source Editor`,
    fileTypes: [`yog.${format}`],
    component: JsonEditor,
    priority: 0,
    kind: "text",
    // The JSON/XAML of this format only — other files have the general editors.
    strict: true,
  });
}

// `.ydata` — binary Yog Data the build compiles formats to: shown as text,
// read only (it's made, not written).
registerEditorProvider({
  id: "yog.ydata",
  label: "Yog Data",
  name: "Compiled Yog Data Viewer",
  icon: "table",
  fileTypes: ["yog.ydata"],
  component: YdataViewer,
  priority: 20,
  kind: "binary",
});

// `.ymodel` body models: the 3D designer by default, the code a click away.
registerEditorProvider({
  id: "yog.ymodel",
  label: "Model",
  name: "Body Model Designer",
  icon: "yogBlock",
  fileTypes: ["yog.ymodel"],
  component: ModelEditor,
  priority: 20,
  kind: "designer",
});

registerEditorProvider({
  id: MODEL_SOURCE_VIEW,
  label: "Code",
  name: "Body Model Source Editor",
  fileTypes: ["yog.ymodel"],
  component: JsonEditor,
  priority: 0,
  kind: "text",
  strict: true,
});

// `.yentity` entity types: the entity in 3D (its model, clips, hitbox) by
// default, the code a click away.
registerEditorProvider({
  id: "yog.yentity",
  label: "Entity",
  name: "Entity Designer",
  icon: "yogEntity",
  fileTypes: ["yog.yentity"],
  component: EntityEditor,
  priority: 20,
  kind: "designer",
});

registerEditorProvider({
  id: ENTITY_SOURCE_VIEW,
  label: "Code",
  name: "Entity Source Editor",
  fileTypes: ["yog.yentity"],
  component: JsonEditor,
  priority: 0,
  kind: "text",
  strict: true,
});
