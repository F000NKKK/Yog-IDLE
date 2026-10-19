import type { EditorProps } from "substrate-platform-ui";
import type { ContentCommands } from "./useContentCommands";
import type { ContentModel } from "./useContentModel";
import type { ContentPaint } from "./useContentPaint";
import type { ContentTextures } from "./useContentTextures";

/** Everything the content editor's parts read: its props, the model, textures, painting and commands. */
export interface ContentView {
  props: EditorProps;
  m: ContentModel;
  tx: ContentTextures;
  pt: ContentPaint;
  cmd: ContentCommands;
}
