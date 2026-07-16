import { FileTree, type FileTreeNode } from "substrate-platform-ui";

const PROJECT_TREE: FileTreeNode[] = [
  {
    id: "forms",
    name: "Forms",
    kind: "folder",
    children: [
      { id: "main-form", name: "MainForm.yog", kind: "file" },
      { id: "login-form", name: "LoginForm.yog", kind: "file" },
      {
        id: "dialogs",
        name: "Dialogs",
        kind: "folder",
        children: [
          { id: "confirm-dialog", name: "ConfirmDialog.yog", kind: "file" },
          { id: "about-dialog", name: "AboutDialog.yog", kind: "file" },
        ],
      },
    ],
  },
  {
    id: "widgets",
    name: "Widgets",
    kind: "folder",
    children: [
      { id: "health-bar", name: "HealthBar.widget", kind: "file" },
      { id: "inventory-slot", name: "InventorySlot.widget", kind: "file" },
    ],
  },
  {
    id: "resources",
    name: "Resources",
    kind: "folder",
    children: [
      { id: "icons", name: "icons", kind: "folder", children: [] },
      { id: "styles", name: "styles.css", kind: "file" },
    ],
  },
  { id: "project-file", name: "YogIdle.project", kind: "file" },
];

/** Placeholder wiring for substrate-platform-ui's FileTree — swap PROJECT_TREE for the real project model once one exists. */
export function SolutionExplorer() {
  return (
    <div style={{ height: "100%", overflow: "auto", padding: "var(--sp-space-xs)", boxSizing: "border-box" }}>
      <FileTree
        nodes={PROJECT_TREE}
        defaultExpandedIds={new Set(["forms"])}
        onActivate={(node) => console.log("open", node.name)}
        getMenuItems={(node) => [
          { label: "Rename", onSelect: (n) => console.log("rename", n.name) },
          { label: "Delete", destructive: true, onSelect: (n) => console.log("delete", n.name) },
        ]}
      />
    </div>
  );
}
