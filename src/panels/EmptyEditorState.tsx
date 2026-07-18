/** The center dock's permanent (but tab-hidden — see `PanelDef.hidden`) placeholder, shown only when no files are open. Every actual open file gets its own real dock tab via `OpenFilesProvider`'s `panels`, not this one. */
export function EmptyEditorState() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--sp-text-faint)" }}>
      <p>Open a file from Project Explorer to start editing.</p>
    </div>
  );
}
