// Project Explorer's commands: what each does, its keys and its menus.

import type { ExplorerOperations } from "./useExplorerOperations";
import type { ExplorerTreeView } from "./useExplorerTreeView";
import type { ExplorerTreeProps } from "../ProjectExplorer";
import { useViewSwitch } from "./commandHooks/useViewSwitch";
import { useExplorerRun } from "./commandHooks/useExplorerRun";
import { useExplorerMenu } from "./commandHooks/useExplorerMenu";
import { useExplorerInput } from "./commandHooks/useExplorerInput";

/** Project Explorer's commands: what each does, its keys and its menus. */
export function useExplorerCommands(props: ExplorerTreeProps, explorerTreeView: ExplorerTreeView, explorerOperations: ExplorerOperations) {
  const viewSwitch = useViewSwitch(explorerTreeView);
  const explorerRun = useExplorerRun(props, explorerTreeView, explorerOperations, viewSwitch);
  const explorerMenu = useExplorerMenu(props, explorerTreeView, explorerOperations, viewSwitch, explorerRun);
  const explorerInput = useExplorerInput(explorerTreeView, explorerOperations, explorerRun);
  const { pairOf, designerView, viewCode, viewDesigner } = viewSwitch;
  const { run, runBuild, item } = explorerRun;
  const { getMenuItems } = explorerMenu;
  const { handleKeyDown, handleBackgroundContextMenu, backgroundItems, button, filterItems, searchCommand, empty } = explorerInput;
  return { run, runBuild, item, getMenuItems, pairOf, designerView, viewCode, viewDesigner, handleKeyDown, handleBackgroundContextMenu, backgroundItems, button, filterItems, searchCommand, empty };
}

/** What `useExplorerCommands` gives the component. */
export type ExplorerCommands = ReturnType<typeof useExplorerCommands>;
