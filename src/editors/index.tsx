import { JsonEditor, registerEditorProvider } from "substrate-platform-ui";
import "../fileTypes";
import { ScreenDesigner } from "../designer/ScreenDesigner";
import { YuiSourceEditor, YuiSplitEditor } from "../designer/YuiSplitEditor";
import { CONTENT_SOURCE_VIEW, ContentEditor } from "./ContentEditor";
import { LangFileEditor } from "./LangFileEditor";
import { BOOK_SOURCE_VIEW, BookEditor } from "./BookEditor";
import { RECIPE_SOURCE_VIEW, RecipeEditor } from "./RecipeEditor";
import { YRES_SOURCE_VIEW, YresEditor } from "./YresEditor";
import { DEF_SOURCE_VIEW, DefEditor } from "./defs/DefEditor";

import { YdataViewer } from "./YdataViewer";
import { MODEL_SOURCE_VIEW, ModelEditor } from "./ModelEditor";
import { ENTITY_SOURCE_VIEW, EntityEditor } from "./EntityEditor";
import { ANIM_SOURCE_VIEW, AnimEditor } from "./AnimEditor";
import { TEXTURE_SOURCE_VIEW, TextureEditor } from "./TextureEditor";
import { fileTypeId, formats } from "../yogFileTypes";
import { LANG_FILE_TYPE } from "../fileTypes";

// Yog-specific editors, on top of the platform's built-in ones — imported
// once for its side effect, before any file opens.

registerEditorProvider({
  id: "yog.lang",
  label: "Translations",
  name: "Translations Designer",
  fileTypes: [LANG_FILE_TYPE],
  component: LangFileEditor,
  priority: 10,
  kind: "designer",
});

// `.yui` screens, as Visual Studio shows XAML: Design and XAML split in one
// tab by default, either one alone a click away. (The split view keeps the
// id the designer used to have, so a remembered "designer" choice becomes it.)
registerEditorProvider({
  id: fileTypeId(formats.ui),
  label: "Design and XAML",
  name: "Screen Designer",
  icon: "splitRows",
  fileTypes: [fileTypeId(formats.ui)],
  component: YuiSplitEditor,
  priority: 20,
  kind: "text",
  strict: true,
});

registerEditorProvider({
  id: "yog.yui.design",
  label: "Designer",
  name: "Screen Designer (Design Only)",
  fileTypes: [fileTypeId(formats.ui)],
  component: ScreenDesigner,
  priority: 10,
  kind: "designer",
});

registerEditorProvider({
  id: "yog.yui.source",
  label: "XAML",
  name: "Screen Source Editor",
  fileTypes: [fileTypeId(formats.ui)],
  component: YuiSourceEditor,
  priority: 0,
  kind: "text",
    // The JSON/XAML of this format only — other files have the general editors.
    strict: true,
});

// `.yres` resource files, as Visual Studio opens `.resx`: the resource table
// by default, the JSON a click (or F7) away.
registerEditorProvider({
  id: fileTypeId(formats.res),
  label: "Resources",
  name: "Resource Editor",
  icon: "table",
  fileTypes: [fileTypeId(formats.res)],
  component: YresEditor,
  priority: 20,
  kind: "designer",
});

registerEditorProvider({
  id: YRES_SOURCE_VIEW,
  label: "Code",
  name: "Resource Source Editor",
  fileTypes: [fileTypeId(formats.res)],
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
  fileTypes: [fileTypeId(formats.block), fileTypeId(formats.item)],
  component: ContentEditor,
  priority: 20,
  kind: "designer",
});

registerEditorProvider({
  id: CONTENT_SOURCE_VIEW,
  label: "Code",
  name: "Block/Item Source Editor",
  fileTypes: [fileTypeId(formats.block), fileTypeId(formats.item)],
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
  fileTypes: [fileTypeId(formats.recipe)],
  component: RecipeEditor,
  priority: 20,
  kind: "designer",
});

registerEditorProvider({
  id: RECIPE_SOURCE_VIEW,
  label: "Code",
  name: "Recipe Source Editor",
  fileTypes: [fileTypeId(formats.recipe)],
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
  fileTypes: [fileTypeId(formats.book)],
  component: BookEditor,
  priority: 20,
  kind: "designer",
});

registerEditorProvider({
  id: BOOK_SOURCE_VIEW,
  label: "Code",
  name: "Book Source Editor",
  fileTypes: [fileTypeId(formats.book)],
  component: JsonEditor,
  priority: 0,
  kind: "text",
    // The JSON/XAML of this format only — other files have the general editors.
    strict: true,
});

// `.ydef` definitions: each kind's designer (an advancement's tab, a loot
// table's odds, a tag's members…), the schema's property grid for kinds
// without one; the code a click away.
registerEditorProvider({
  id: fileTypeId(formats.def),
  label: "Designer",
  name: "Definition Editor",
  icon: "yogDef",
  fileTypes: [fileTypeId(formats.def)],
  component: DefEditor,
  priority: 20,
  kind: "designer",
});

registerEditorProvider({
  id: DEF_SOURCE_VIEW,
  label: "Code",
  name: "Definition Source Editor",
  fileTypes: [fileTypeId(formats.def)],
  component: JsonEditor,
  priority: 0,
  kind: "text",
  strict: true,
});

// `.ydata` — binary Yog Data the build compiles formats to: shown as text,
// read only (it's made, not written).
registerEditorProvider({
  id: fileTypeId(formats.data),
  label: "Yog Data",
  name: "Compiled Yog Data Viewer",
  icon: "table",
  fileTypes: [fileTypeId(formats.data)],
  component: YdataViewer,
  priority: 20,
  kind: "binary",
});

// `.ymodel` body models: the 3D designer by default, the code a click away.
registerEditorProvider({
  id: fileTypeId(formats.model),
  label: "Model",
  name: "Body Model Designer",
  icon: "yogBlock",
  fileTypes: [fileTypeId(formats.model)],
  component: ModelEditor,
  priority: 20,
  kind: "designer",
});

registerEditorProvider({
  id: MODEL_SOURCE_VIEW,
  label: "Code",
  name: "Body Model Source Editor",
  fileTypes: [fileTypeId(formats.model)],
  component: JsonEditor,
  priority: 0,
  kind: "text",
  strict: true,
});

// `.yentity` entity types: the entity in 3D (its model, clips, hitbox) by
// default, the code a click away.
registerEditorProvider({
  id: fileTypeId(formats.entity),
  label: "Entity",
  name: "Entity Designer",
  icon: "yogEntity",
  fileTypes: [fileTypeId(formats.entity)],
  component: EntityEditor,
  priority: 20,
  kind: "designer",
});

registerEditorProvider({
  id: ENTITY_SOURCE_VIEW,
  label: "Code",
  name: "Entity Source Editor",
  fileTypes: [fileTypeId(formats.entity)],
  component: JsonEditor,
  priority: 0,
  kind: "text",
  strict: true,
});

// `.yanim` clips: a timeline over the clip played in 3D by default, the
// code a click away.
registerEditorProvider({
  id: fileTypeId(formats.anim),
  label: "Timeline",
  name: "Animation Designer",
  icon: "yogAnim",
  fileTypes: [fileTypeId(formats.anim)],
  component: AnimEditor,
  priority: 20,
  kind: "designer",
});

registerEditorProvider({
  id: ANIM_SOURCE_VIEW,
  label: "Code",
  name: "Animation Source Editor",
  fileTypes: [fileTypeId(formats.anim)],
  component: JsonEditor,
  priority: 0,
  kind: "text",
  strict: true,
});

// `.ytexture` textures: the picture painted, how the game takes it in
// Properties; the file's text a click (or F7) away.
registerEditorProvider({
  id: fileTypeId(formats.texture),
  label: "Texture",
  name: "Texture Editor",
  icon: "yogTexture",
  fileTypes: [fileTypeId(formats.texture)],
  component: TextureEditor,
  priority: 20,
  kind: "designer",
});

registerEditorProvider({
  id: TEXTURE_SOURCE_VIEW,
  label: "Code",
  name: "Texture Source Editor",
  fileTypes: [fileTypeId(formats.texture)],
  component: JsonEditor,
  priority: 0,
  kind: "text",
  strict: true,
});
