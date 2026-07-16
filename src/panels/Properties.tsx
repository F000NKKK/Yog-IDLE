import { DataGrid, type DataGridColumn } from "substrate-platform-ui";

interface PropertyRow {
  id: string;
  category: string;
  name: string;
  value: string;
}

const PROPERTIES: PropertyRow[] = [
  { id: "p1", category: "Layout", name: "X", value: "24" },
  { id: "p2", category: "Layout", name: "Y", value: "160" },
  { id: "p3", category: "Layout", name: "Width", value: "320" },
  { id: "p4", category: "Layout", name: "Height", value: "48" },
  { id: "p5", category: "Appearance", name: "Background", value: "#28282b" },
  { id: "p6", category: "Appearance", name: "Border Radius", value: "8" },
  { id: "p7", category: "Appearance", name: "Opacity", value: "1.0" },
  { id: "p8", category: "Behavior", name: "Visible", value: "true" },
  { id: "p9", category: "Behavior", name: "Enabled", value: "true" },
  { id: "p10", category: "Behavior", name: "Tab Index", value: "3" },
];

const columns: DataGridColumn<PropertyRow>[] = [
  { key: "category", header: "Category", width: 110, sortable: true, sortValue: (r) => r.category },
  { key: "name", header: "Name", width: 140, sortable: true, sortValue: (r) => r.name },
  { key: "value", header: "Value", width: 140 },
];

/** Placeholder wiring for substrate-platform-ui's DataGrid — swap PROPERTIES for the selected widget's real style fields once selection exists. */
export function Properties() {
  return (
    <div style={{ height: "100%", padding: "var(--sp-space-xs)", boxSizing: "border-box" }}>
      <DataGrid columns={columns} rows={PROPERTIES} getRowId={(r) => r.id} defaultGroupBy={["category"]} filterRow={false} />
    </div>
  );
}
