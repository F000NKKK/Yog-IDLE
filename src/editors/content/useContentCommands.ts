// Element and block-state commands, the keyboard and Edit menu, and the Properties rows.

import type { EditorProps } from "substrate-platform-ui";
import { CONTENT_SOURCE_VIEW } from "./contentModel";
import { elementCommands } from "./elementCommands";
import { stateEdits, statePicking } from "./stateCommands";
import type { ContentModel } from "./useContentModel";
import type { ContentPaint } from "./useContentPaint";
import { useContentKeys } from "./useContentKeys";
import { useContentPropertyRows } from "./useContentPropertyRows";

/** Element and block-state commands, the keyboard and Edit menu, and the Properties rows. */
export function useContentCommands(props: EditorProps, m: ContentModel, pt: ContentPaint) {
  const { path, readOnly } = props;
  const elements = elementCommands(m);
  const picking = statePicking(m);
  const edits = stateEdits(m, picking);
  const viewCode = () => {
    const tab = m.tabs.find((x) => x.path === path);
    if (tab) void m.setView(tab.id, CONTENT_SOURCE_VIEW);
  };
  /** Deletes the picked element, else the picked property, state model or variant. */
  const deleteSelected = () => (m.sel === null && m.pickedState ? edits.removeStateItem(m.pickedState) : elements.deleteElement());
  const { pickGizmo } = useContentKeys(props, m, elements, deleteSelected, viewCode);
  const properties = useContentPropertyRows(readOnly, m, pt, picking);
  return { ...elements, ...picking, ...edits, viewCode, deleteSelected, pickGizmo, properties };
}

/** What `useContentCommands` gives the editor. */
export type ContentCommands = ReturnType<typeof useContentCommands>;
