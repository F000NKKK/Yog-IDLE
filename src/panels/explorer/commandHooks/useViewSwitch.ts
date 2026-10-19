// Switching a file between its code and its designer.

import { EDITOR_KIND, editorProvidersFor, fileNameOf, type FileTreeNode, generalEditorProviders, openFile } from "substrate-platform-ui";
import { codeBehindPair } from "../explorerModel";
import { findNode } from "../projectTree";
import type { ExplorerTreeView } from "../useExplorerTreeView";

/** Switching a file between its code and its designer. */
export function useViewSwitch(explorerTreeView: ExplorerTreeView) {
  const { projectItems, shownNodes } = explorerTreeView;
  /** What each command does to the node it's invoked on (the focused one, from the toolbar and the keyboard). */
  function pairOf(node: FileTreeNode) {
    const pair = codeBehindPair(node.id);
    if (!pair) return null;
    const exists = (path: string) => !!findNode(shownNodes, path) || !!projectItems?.has(path);
    return exists(pair.screen) && exists(pair.code) ? pair : null;
  }

  /** The file's designer view (`.yui`, `.yblock`…), if it has one. */
  function designerView(path: string) {
    return editorProvidersFor(path).find((p) => p.kind === EDITOR_KIND.designer);
  }

  /** F7, as in Visual Studio: a screen's code-behind, else the file in a code editor. */
  function viewCode(node: FileTreeNode) {
    if (node.kind !== "file") return;
    const pair = pairOf(node);
    if (pair && node.id === pair.screen) {
      openFile({ path: pair.code, name: fileNameOf(pair.code) });
      return;
    }
    const code = editorProvidersFor(node.id).find((p) => p.kind === EDITOR_KIND.text) ?? generalEditorProviders().find((p) => p.kind === EDITOR_KIND.text);
    openFile({ path: node.id, name: node.name, view: code?.id });
  }

  /** Shift+F7: a code-behind's screen, else the file's designer. */
  function viewDesigner(node: FileTreeNode) {
    if (node.kind !== "file") return;
    const pair = pairOf(node);
    if (pair && node.id === pair.code) {
      openFile({ path: pair.screen, name: fileNameOf(pair.screen) });
      return;
    }
    const designer = designerView(node.id);
    if (designer) openFile({ path: node.id, name: node.name, view: designer.id });
  }

  return { pairOf, designerView, viewCode, viewDesigner };
}

/** What `useViewSwitch` gives. */
export type ViewSwitch = ReturnType<typeof useViewSwitch>;
