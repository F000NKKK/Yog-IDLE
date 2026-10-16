import { pt, t } from "substrate-platform-ui";

// Project Explorer's commands — each declared once, here: its name, its
// shortcut and its toolbar icon. The context menus, the toolbar, the tree's
// own keys and the IDE-wide keybindings (`ExplorerKeybindings`) are all
// built from this table, so a command reads and binds the same everywhere.

export interface ExplorerCommand {
  /** English, translated where it's shown (`commandLabel`). */
  label: string;
  /** Tells the label apart from the same English word meaning something else (`pt`). */
  context?: string;
  /** Visual Studio's, as keybindings write it; chords as `"Ctrl+[ S"`. */
  shortcut?: string;
  icon?: string;
  /** Bound IDE-wide (it brings Project Explorer up), not only while the tree has the focus. */
  global?: boolean;
}

export const EXPLORER_COMMANDS = {
  open: { label: "Open" },
  openWith: { label: "Open With" },
  viewCode: { label: "View Code", shortcut: "F7" },
  viewDesigner: { label: "View Designer", shortcut: "Shift+F7" },
  build: { label: "Build", context: "command" },
  clean: { label: "Clean" },
  add: { label: "Add" },
  newItem: { label: "New Item..." },
  quickAdd: { label: "Quick Add...", shortcut: "Ctrl+Shift+A" },
  addExisting: { label: "Existing Item...", shortcut: "Shift+Alt+A" },
  newFile: { label: "New File" },
  newFolder: { label: "New Folder" },
  scopeToThis: { label: "Scope to This" },
  newView: { label: "New Project Explorer View" },
  openFolderInFileExplorer: { label: "Open Folder in File Explorer" },
  openContainingFolder: { label: "Open Containing Folder" },
  openInTerminal: { label: "Open in Terminal" },
  cut: { label: "Cut", shortcut: "Ctrl+X" },
  copy: { label: "Copy", shortcut: "Ctrl+C" },
  paste: { label: "Paste", shortcut: "Ctrl+V" },
  duplicate: { label: "Duplicate", shortcut: "Ctrl+D" },
  delete: { label: "Delete", shortcut: "Delete" },
  rename: { label: "Rename", shortcut: "F2" },
  copyFullPath: { label: "Copy Full Path" },
  copyRelativePath: { label: "Copy Relative Path" },
  collapseDescendants: { label: "Collapse All Descendants" },
  collapseAll: { label: "Collapse All", icon: "collapse" },
  properties: { label: "Properties", shortcut: "Alt+Enter", icon: "properties" },
  back: { label: "Back", context: "navigation", icon: "arrowLeft" },
  forward: { label: "Forward", icon: "arrowRight" },
  home: { label: "Home", icon: "home" },
  syncActive: { label: "Sync with Active Document", shortcut: "Ctrl+[ S", icon: "locate", global: true },
  trackActive: { label: "Track Active Item", icon: "link" },
  showAllFiles: { label: "Show All Files", icon: "files" },
  filters: { label: "Filters", icon: "filter" },
  filterOpenFiles: { label: "Open Files Filter", shortcut: "Ctrl+[ O", global: true },
  filterPendingChanges: { label: "Pending Changes Filter", shortcut: "Ctrl+[ P", global: true },
  refresh: { label: "Refresh", icon: "refresh" },
  search: { label: "Search Project Explorer", shortcut: "Ctrl+;", icon: "search", global: true },
  searchContents: { label: "Search Within File Contents" },
} satisfies Record<string, ExplorerCommand>;

export type ExplorerCommandId = keyof typeof EXPLORER_COMMANDS;

export const explorerCommand = (id: ExplorerCommandId): ExplorerCommand => EXPLORER_COMMANDS[id];

/** A command's name in the active locale. */
export function commandLabel(id: ExplorerCommandId): string {
  const { label, context } = explorerCommand(id);
  return context ? pt(context, label) : t(label);
}

/** The commands bound to keys, local (the tree focused) or IDE-wide. */
export function boundCommands(global: boolean): [ExplorerCommandId, ExplorerCommand & { shortcut: string }][] {
  return (Object.entries(EXPLORER_COMMANDS) as [ExplorerCommandId, ExplorerCommand][]).filter(
    (entry): entry is [ExplorerCommandId, ExplorerCommand & { shortcut: string }] => !!entry[1].shortcut && !!entry[1].global === global
  );
}

/** The keybinding id a user keymap rebinds a command by. */
export const keybindingId = (id: ExplorerCommandId) => `explorer.${id}`;
