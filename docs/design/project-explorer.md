# Project Explorer vs Visual Studio 2026's Solution Explorer

What Solution Explorer has, and where Project Explorer stands. Generic tree
behaviour lives in Substrate (`Tree`, `FileTree`, `useDirectoryTree`,
`filterFileTree`, `SearchField`); the Yog parts (file nesting, generated code,
the commands) in `src/panels/ProjectExplorer.tsx` and `src/panels/explorer/`.
Every command is declared once in `explorer/commands.ts`; menus, toolbar and
keys are built from it.

| Solution Explorer | Project Explorer |
|---|---|
| Search box (Ctrl+;): filters as you type, matches marked, parents kept | yes — names, plus "Search Within File Contents" (`project_files_containing`) |
| Back / Forward / Home, Scope to This | yes |
| New Solution Explorer View | New Project Explorer View — one extra view (a transient tool window) |
| Switch Views (solution / folder) | not applicable: a Yog project is its folder |
| Filters: Pending Changes (Ctrl+[ P), Open Files (Ctrl+[ O) | yes |
| Sync with Active Document (Ctrl+[ S), Track Active Item | yes |
| Refresh, Collapse All, Collapse All Descendants | yes |
| Show All Files | yes — off hides git-ignored files, build output and VCS metadata; on shows them dimmed |
| Properties (Alt+Enter) | yes |
| Preview Selected Items | no — IDLE has no preview tabs |
| Open, Open With…, View Code (F7) / View Designer (Shift+F7) | yes |
| Add > New Item / Quick Add (Ctrl+Shift+A) / Existing Item (Shift+Alt+A) / New Folder | yes, plus New File; new names typed in place |
| Cut / Copy / Paste / Delete / Rename (F2, in place) | yes, plus Duplicate (Ctrl+D); cut items dimmed |
| Copy Full Path / Copy Relative Path, Open Containing Folder, Open in Terminal | yes |
| Exclude From Project | no — a Yog project has no exclusion list (everything in the folder is the project) |
| Keyboard: arrows select, Shift extends, Ctrl moves focus, Left/Right, `*`, keypad +/−, Home/End/PageUp/PageDown, type-ahead | yes (Substrate `Tree`) |
| Multi-select, drag and drop (Ctrl copies) | yes |
| Source-control glyphs | status letters on files (M, A, U, …), a dot on folders holding changes |
| Expanded state remembered per project | yes (with Show All Files, Track Active Item, the contents-search option) |
