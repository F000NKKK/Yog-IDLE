# Yog-IDLE

An IDE for [Yog](https://github.com/F000NKKK/Yog-Mod-Loader) Minecraft
mods — edit, build, run, debug, and hot-reload a mod from a Visual
Studio–style layout (Project Explorer, editor tabs, Output log, integrated
Terminal, Debug panel, Properties) and a visual `yog-ui` screen designer
(Toolbox, a WinForms-style design canvas, Properties, Document Outline).

Built with [Tauri](https://tauri.app/) (Rust backend, web frontend) on top
of [Substrate Platform](https://github.com/F000NKKK/Substrate-Platform), a
brand-neutral IDE core (task runner, log sink, generic project/build
plumbing, plus its own docking/tool-window shell and widget set) —
Yog-IDLE is its first product. The terminal uses
[xterm.js](https://xtermjs.org/) (backed by a real PTY via
`portable-pty` on the Rust side) — the same terminal tech VS Code itself
uses.

## Development

```sh
npm install
npm run tauri dev
```

## Status

Works today:

- **Projects** — open a folder or a `yog.toml`; the last project is
  reopened on startup and recent ones are listed in the File menu, along
  with Close / Close All / Close Folder, Save / Save As / Save All and
  Exit. Project Explorer with create/rename/delete and Open With.
- **Editor** — CodeMirror tabs with pinning and a Visual Studio–style tab
  menu (close others / to the right / unpinned, copy path, Open With);
  Undo/Redo, Toggle Comment (Ctrl+/) and the rest of the Edit menu act on
  the focused editor. Files can have several views, switched from buttons
  in the tab strip: Markdown has Source, Preview and Preview to the Side
  (Ctrl+Shift+V, Ctrl+K V) with GFM, footnotes, alerts, KaTeX math,
  highlighted code and Mermaid diagrams; `.yres` resource files
  (texts per language, images, sounds, colors — see
  [docs/yres.md](docs/yres.md)) open in a ResX-style resource table with a
  column per language. The chosen view is remembered per extension.
- **Properties** — a Visual Studio–style property grid for the selection
  (project, `yog.toml` entries, files), edited in place and written back
  with formatting preserved.
- **Screen designer** — `.yui` files (a XAML-like form of a `yog-ui`
  widget tree, see [docs/yui.md](docs/yui.md)) open in a Visual Studio
  WinForms–style designer, with the XML in a Source view: the screen drawn
  Minecraft-style at a chosen GUI size and zoom, laid out exactly as
  `yog-ui` will; select (click, Ctrl/Shift+click, rubber band), move and
  resize with handles, snaplines and a grid; drop widgets from the Toolbox
  (or double-click them); nest them in Canvas/Row/Column containers;
  arrow-key nudge, cut/copy/paste/duplicate, z-order and undo/redo; every
  attribute editable in Properties. Saving regenerates the screen's
  `.yog-build/generated/<name>.g.rs` (`yog ui gen`), pulled in by its
  code-behind module with `yog_api::ui_include!`.
- **Build & publish** — Build (`yog build`) and saved publish profiles
  (package as `.yog`, or `yog publish exports`), with output streamed to
  the Output panel, which keeps a separate source per producer (Build,
  Run, Debug, Game) like Visual Studio's "Show output from".
- **Run** — `[run.<name>]` targets from `yog.toml` (`yog run <name>`),
  Release or Debug mode; Stop/Restart from the toolbar. The game outlives
  the IDE if it's closed. On Linux the game reports in over
  `yog-runtime`'s control socket, driving the status bar (pid, loaded
  mods).
- **Hot reload** (Linux) — rebuilds the mod and swaps the new `.yog` into
  the running game over the control socket; only works while the ABI
  version is unchanged.
- **Native debugging** (Linux, `ptrace`) — Debug-mode runs attach
  `yog-debugger` to the game: gutter breakpoints (settable before or during
  a session), Break All (stops the render and server threads only, so
  audio and networking keep going), Continue and Step Over/Into/Out, a
  per-thread call stack unwound with DWARF CFI, Just My Code (frames
  outside the mod collapsed), and a Locals view.
- Integrated terminal(s), settings window, and the Substrate docking shell.

Planned:

- Live preview of a designed screen in the running client (hot reload of
  the regenerated code over the control socket).
- Watch expressions and values on hover while debugging.
- Debugging and hot reload on Windows and macOS.

## License

Dual-licensed: **AGPL-3.0-only** (see [LICENSE](LICENSE)) — free for any
use, provided you comply with the AGPL — or a **Commercial License** for
closed-source use, free below $1,000/mo net profit and a sliding royalty
above that. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) for details.
